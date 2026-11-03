"""
Zone atteignable à pied en N minutes depuis un point, le long des vraies rues.

1. On télécharge (une seule fois, puis cache disque) les rues piétonnes autour du point.
2. On en fait un graphe : chaque tronçon de rue est une arête pondérée par sa longueur.
3. Dijkstra depuis le carrefour le plus proche donne la distance de marche vers chaque nœud.
4. Les tronçons atteints (entièrement ou en partie) sont élargis de 40 m pour former la zone.

Si les rues ne sont pas encore disponibles, on utilise une estimation à vol d'oiseau
corrigée d'un facteur de détour (les rues ne vont jamais tout droit).
"""

# --- Bibliothèques utilisées ---
# networkx : graphes (algorithme de Dijkstra) ; numpy : calcul sur des tableaux de nombres ;
# pyproj : conversion latitude/longitude <-> mètres ; shapely : formes géométriques.
import json
import logging
import math
from functools import lru_cache

import networkx as nx
import numpy as np
import requests
from pyproj import Transformer
from shapely import STRtree, buffer, points, union_all
from shapely.geometry import LineString, MultiPolygon, Point, Polygon
from shapely.ops import transform

from app.db import DATA_DIR
from app.services.geo import OVERPASS_URLS, walk_radius_meters

logger = logging.getLogger("caremap-isochrone")

# Dossier où les rues téléchargées sont gardées (un fichier JSON par quartier)
STREETS_DIR = DATA_DIR / "streets"
STREETS_DIR.mkdir(parents=True, exist_ok=True)

# Un trajet à pied réel est en moyenne ~30 % plus long que la ligne droite
DETOUR_FACTOR = 1.3
# Largeur de part et d'autre d'une rue considérée comme atteinte (bâtiments riverains)
STREET_BUFFER_M = 40
# Au-delà, un point est trop loin de toute rue connue pour s'y raccrocher
MAX_SNAP_M = 250
# Trous (îlots sans rue traversante) plus petits que 5 ha : comblés, ce ne sont pas des déserts
MIN_HOLE_M2 = 50_000
# Les zones de rues sont alignées sur une grille de 0,005° (~500 m) pour être réutilisées
GRID_DEG = 0.005
# Marge ajoutée au rayon de marche lors du téléchargement des rues (en mètres)
MARGIN_M = 700

# Types de routes exclus : autoroutes, voies rapides, routes en construction...
# (on ne peut pas y marcher)
EXCLUDED_HIGHWAYS = "motorway|motorway_link|trunk|trunk_link|construction|proposed|raceway|bus_guideway|busway"


# Le centre est arrondi à la grille : deux positions proches partagent le même fichier de rues.
# Le rayon (dist) est arrondi au multiple de 250 m supérieur.
def streets_key(lat: float, lon: float, minutes: int) -> tuple[float, float, int]:
    """Identifiant de la zone de rues couvrant un trajet de `minutes` depuis (lat, lon)."""
    center_lat = round(round(lat / GRID_DEG) * GRID_DEG, 4)
    center_lon = round(round(lon / GRID_DEG) * GRID_DEG, 4)
    dist = int(math.ceil((walk_radius_meters(minutes) + MARGIN_M) / 250) * 250)
    return center_lat, center_lon, dist


# Nom du fichier de cache, ex. data/streets/34.0200_-6.8350_3000.json
def _streets_path(key: tuple[float, float, int]):
    return STREETS_DIR / f"{key[0]:.4f}_{key[1]:.4f}_{key[2]}.json"


# Cherche dans le dossier un fichier déjà téléchargé pour ce quartier et assez grand
def find_streets(lat: float, lon: float, minutes: int) -> tuple[float, float, int] | None:
    """Zone de rues déjà téléchargée assez grande pour ce trajet (même centre, rayon ≥ requis)."""
    center_lat, center_lon, needed = streets_key(lat, lon, minutes)
    available = [
        int(path.stem.rsplit("_", 1)[1]) for path in STREETS_DIR.glob(f"{center_lat:.4f}_{center_lon:.4f}_*.json")
    ]
    large_enough = [dist for dist in available if dist >= needed]
    return (center_lat, center_lon, min(large_enough)) if large_enough else None


def download_streets(key: tuple[float, float, int]) -> bool:
    """Télécharge les rues piétonnes de la zone depuis Overpass et les enregistre sur disque."""
    lat, lon, dist = key
    # Requête Overpass : toutes les voies (way) où l'on peut marcher, dans un cercle de `dist` mètres.
    # (._;>;) ajoute les nœuds (points) de chaque voie ; « skel qt » = version allégée.
    query = f"""[out:json][timeout:50];
    way["highway"]["highway"!~"^({EXCLUDED_HIGHWAYS})$"]["foot"!~"^no$"]["access"!~"^(private|no)$"]
      (around:{dist},{lat},{lon});
    (._;>;);
    out skel qt;
    """
    headers = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}
    for overpass_url in OVERPASS_URLS:
        try:
            resp = requests.post(overpass_url, data={"data": query}, headers=headers, timeout=60)
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
        except Exception as e:
            logger.warning(f"Overpass {overpass_url} unavailable for streets ({e}).")
            continue
        # Succès : on enregistre les rues sur disque et on s'arrête là
        _streets_path(key).write_text(json.dumps(elements))
        logger.info(f"Rues : {len(elements)} éléments enregistrés pour {key}.")
        return True
    return False


# Un graphe = des nœuds (carrefours, points des rues) reliés par des arêtes (tronçons de rue).
# Chaque arête a une longueur en mètres : c'est ce que Dijkstra additionne.
class StreetGraph:
    """Graphe des rues projeté en mètres autour du centre de la zone."""

    def __init__(self, key: tuple[float, float, int]):
        center_lat, center_lon, _ = key
        # Projection « azimutale équidistante » centrée sur le quartier : les coordonnées deviennent
        # des mètres (x, y) autour du centre, ce qui permet de calculer des distances simplement.
        proj = f"+proj=aeqd +lat_0={center_lat} +lon_0={center_lon} +units=m +datum=WGS84"
        self.to_m = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
        self.to_deg = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)

        elements = json.loads(_streets_path(key).read_text())
        # Lecture du fichier : d'abord les nœuds (id -> coordonnées), convertis en mètres
        nodes = {el["id"]: (el["lon"], el["lat"]) for el in elements if el["type"] == "node"}
        ids = list(nodes)
        xs, ys = self.to_m.transform([nodes[i][0] for i in ids], [nodes[i][1] for i in ids])
        self.coords = {node_id: (x, y) for node_id, x, y in zip(ids, xs, ys, strict=True)}

        # Puis les voies : chaque paire de nœuds consécutifs devient une arête
        self.graph = nx.Graph()
        for el in elements:
            if el["type"] != "way":
                continue
            refs = [ref for ref in el.get("nodes", []) if ref in self.coords]
            for u, v in zip(refs, refs[1:], strict=False):
                (x1, y1), (x2, y2) = self.coords[u], self.coords[v]
                self.graph.add_edge(u, v, length=math.hypot(x2 - x1, y2 - y1))

        self.node_ids = np.array(list(self.graph.nodes))
        # Index spatial pour trouver vite le carrefour le plus proche d'un point
        self.tree = STRtree(points(np.array([self.coords[n] for n in self.node_ids]).reshape(-1, 2)))

    # Convertit des latitudes/longitudes en mètres (x, y) dans le repère du quartier
    def project(self, lats, lons) -> np.ndarray:
        xs, ys = self.to_m.transform(np.asarray(lons, dtype=float), np.asarray(lats, dtype=float))
        return np.column_stack([np.atleast_1d(xs), np.atleast_1d(ys)])

    def snap(self, points_xy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Nœud de rue le plus proche de chaque point, et distance jusqu'à lui."""
        (point_idx, node_idx), dists = self.tree.query_nearest(
            points(points_xy), return_distance=True, all_matches=False
        )
        order = np.argsort(point_idx)
        return self.node_ids[node_idx[order]], dists[order]


# lru_cache garde en mémoire les 8 derniers graphes construits (évite de relire le fichier)
@lru_cache(maxsize=8)
def _load_graph(key: tuple[float, float, int]) -> StreetGraph:
    return StreetGraph(key)


# Objet renvoyé à main.py : la zone (polygone) et une fonction walk_meters(lats, lons)
# qui donne la distance de marche vers n'importe quels points.
class ReachableArea:
    """Résultat : polygone atteignable (WGS84) + distance de marche vers n'importe quel point."""

    def __init__(self, polygon, walk_meters_fn, method: str):
        self.polygon = polygon
        self.walk_meters = walk_meters_fn
        self.method = method  # "streets" ou "straight_line"


# Utilisée tant que les rues ne sont pas téléchargées (affichée « estimation » dans l'interface)
def straight_line_area(lat: float, lon: float, minutes: int) -> ReachableArea:
    """Estimation sans rues : cercle de rayon (distance de marche / facteur de détour)."""
    proj = f"+proj=aeqd +lat_0={lat} +lon_0={lon} +units=m +datum=WGS84"
    to_m = Transformer.from_crs("EPSG:4326", proj, always_xy=True)
    to_deg = Transformer.from_crs(proj, "EPSG:4326", always_xy=True)
    # Rayon réduit par le facteur de détour : 1125 m de marche ≈ 865 m en ligne droite
    circle = Point(0, 0).buffer(walk_radius_meters(minutes) / DETOUR_FACTOR, resolution=32)

    def walk_meters(lats, lons):
        xs, ys = to_m.transform(np.asarray(lons, dtype=float), np.asarray(lats, dtype=float))
        return [float(d) * DETOUR_FACTOR for d in np.hypot(np.atleast_1d(xs), np.atleast_1d(ys))]

    return ReachableArea(transform(to_deg.transform, circle), walk_meters, "straight_line")


# Sans cela, les cours d'immeubles et îlots sans rue apparaîtraient comme des « déserts »
def _fill_small_holes(geom):
    """Supprime les petits trous intérieurs (cœurs d'îlots, cours) du polygone atteignable."""
    parts = geom.geoms if isinstance(geom, MultiPolygon) else [geom]
    filled = [
        Polygon(part.exterior, [ring for ring in part.interiors if Polygon(ring).area >= MIN_HOLE_M2]) for part in parts
    ]
    return union_all(filled)


def street_area(lat: float, lon: float, minutes: int) -> ReachableArea | None:
    """Zone atteignable le long des rues, ou None si les rues ne sont pas (encore) en cache."""
    key = find_streets(lat, lon, minutes)
    if key is None:
        return None
    return _street_area(round(lat, 5), round(lon, 5), minutes, key)


# Le fichier de rues ne change plus une fois téléchargé : le résultat peut être mémorisé
# (le frontend redemande la même zone toutes les 3 s pendant les téléchargements).
@lru_cache(maxsize=32)
def _street_area(lat: float, lon: float, minutes: int, key: tuple[float, float, int]) -> ReachableArea | None:
    # 1. Le graphe des rues du quartier
    street_graph = _load_graph(key)
    if not len(street_graph.node_ids):
        return None

    radius = walk_radius_meters(minutes)
    # 2. On rattache la position de l'utilisateur au point de rue le plus proche (snap)
    origin_xy = street_graph.project([lat], [lon])
    (origin_node,), (snap_dist,) = street_graph.snap(origin_xy)
    snap_dist = float(snap_dist)
    if snap_dist > MAX_SNAP_M:
        return None

    # 3. Dijkstra : distance de marche la plus courte depuis l'origine vers chaque nœud,
    #    en s'arrêtant au rayon de marche (cutoff) pour aller plus vite.
    reached = nx.single_source_dijkstra_path_length(
        street_graph.graph, origin_node, cutoff=radius - snap_dist, weight="length"
    )
    reached = {node: d + snap_dist for node, d in reached.items()}

    # Tronçons atteints : entièrement, ou partiellement depuis l'une ou l'autre extrémité
    # 4. On garde les morceaux de rues atteints. left_u / left_v = mètres de marche qu'il
    #    reste en arrivant à chaque extrémité du tronçon (négatif = extrémité non atteinte).
    segments = [LineString([tuple(origin_xy[0]), street_graph.coords[origin_node]])]
    for u, v, data in street_graph.graph.edges(data=True):
        left_u = radius - reached[u] if u in reached else -1
        left_v = radius - reached[v] if v in reached else -1
        if left_u <= 0 and left_v <= 0:
            continue
        line = LineString([street_graph.coords[u], street_graph.coords[v]])
        length = data["length"]
        if max(left_u, left_v) >= length or (left_u > 0 and left_v > 0 and left_u + left_v >= length):
            segments.append(line)
            continue
        if left_u > 0:
            segments.append(LineString([line.coords[0], line.interpolate(left_u).coords[0]]))
        if left_v > 0:
            segments.append(LineString([line.interpolate(length - left_v).coords[0], line.coords[1]]))

    # Élargir chaque tronçon puis fusionner : ~10x plus rapide qu'un seul buffer sur l'ensemble
    # 5. Les rues atteintes, élargies de 40 m et fusionnées, forment la zone atteignable
    area_m = union_all(buffer(np.array(segments, dtype=object), STREET_BUFFER_M, quad_segs=4))
    area_m = _fill_small_holes(area_m).simplify(4)
    # Retour en latitude/longitude pour l'affichage sur la carte
    polygon = transform(street_graph.to_deg.transform, area_m)

    # Distance de marche vers des lieux : distance Dijkstra jusqu'à leur nœud de rue
    # + petit trajet entre la rue et le lieu.
    def walk_meters(lats, lons):
        points = street_graph.project(lats, lons)
        if not len(points):
            return []
        nodes, snaps = street_graph.snap(points)
        result = []
        for (x, y), node, snap in zip(points, nodes, snaps, strict=True):
            if node in reached and snap <= MAX_SNAP_M:
                result.append(reached[node] + float(snap))
            else:
                # Hors de la zone calculée : estimation à vol d'oiseau
                straight = math.hypot(x - origin_xy[0][0], y - origin_xy[0][1])
                result.append(max(straight * DETOUR_FACTOR, radius + 1))
        return result

    return ReachableArea(polygon, walk_meters, "streets")
