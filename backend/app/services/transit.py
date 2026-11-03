"""
Bus et tramway à partir d'OpenStreetMap.

1. On télécharge (une fois, puis cache disque) par tuiles de 0,1° (~11 km) :
   les arrêts de bus et de tram, les lignes (relations « route ») qui les desservent,
   et le tracé des voies de tram.
2. Pour un trajet A → B, on recommande plusieurs itinéraires, du plus rapide au plus lent :
   une ligne directe, une ligne qui rapproche puis la fin à pied, ou une correspondance.

Il n'existe pas d'horaires publics pour la plupart des villes marocaines :
le temps donné ne compte pas l'attente à l'arrêt, et l'application le dit.
"""

import json
import logging
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import requests

from app.db import DATA_DIR
from app.services.geo import OVERPASS_URLS
from app.services.routing import DETOUR_FACTOR, WALK_SPEED_MS, straight_distance_m

logger = logging.getLogger("caremap-transit")

# Sous-dossier par taille de tuile : changer TILE_DEG n'utilise jamais d'anciens fichiers
# Les tuiles téléchargées sont gardées dans backend/data/transit/t010/
TRANSIT_DIR = DATA_DIR / "transit" / "t010"
TRANSIT_DIR.mkdir(parents=True, exist_ok=True)

# Grandes tuiles : une agglomération comme Rabat-Salé tient en 1 à 4 téléchargements
# Taille d'une tuile (0,1° ≈ 11 km) ; MAX_TILES : au-delà, la zone est trop grande
TILE_DEG = 0.1
MAX_TILES = 4
RETRY_AFTER_SECONDS = 60
# Distance maximale (à vol d'oiseau) jusqu'à un arrêt pour qu'il soit proposé
MAX_STOP_DISTANCE_M = 900
# Vitesses commerciales moyennes en ville, arrêts compris
RIDE_SPEED_KMH = {"tram": 20.0, "bus": 15.0}
# Trajet minimum en bus/tram (moins de 300 m, autant marcher)
MIN_RIDE_M = 300
# Les lignes ne vont pas tout droit d'un arrêt à l'autre
RIDE_DETOUR = 1.15
# Correspondance : marche jusqu'à 300 m + forfait de changement
TRANSFER_RADIUS_M = 300
TRANSFER_PENALTY_MIN = 5
# Nombre maximum d'itinéraires proposés à l'utilisateur
MAX_OPTIONS = 4
# Au-delà, descendre et finir à pied n'est plus une vraie recommandation
MAX_LAST_WALK_MIN = 20

HEADERS = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}

# Téléchargements en arrière-plan (une seule file) et suivi de leur état
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="osm-transit")
_lock = threading.Lock()
_in_progress: set[tuple[int, int]] = set()
_failed_at: dict[tuple[int, int], float] = {}
# Tuiles déjà lues depuis le disque, gardées en mémoire
_tile_cache: dict[tuple[int, int], dict] = {}


# --- Tuiles ---------------------------------------------------------------------


# Liste des tuiles (ligne, colonne) qui recouvrent un rectangle de carte
def tiles_for_bbox(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> list[tuple[int, int]]:
    lat_range = range(math.floor(min_lat / TILE_DEG), math.floor(max_lat / TILE_DEG) + 1)
    lon_range = range(math.floor(min_lon / TILE_DEG), math.floor(max_lon / TILE_DEG) + 1)
    return [(i, j) for i in lat_range for j in lon_range]


def _tile_path(tile: tuple[int, int]):
    return TRANSIT_DIR / f"{tile[0]}_{tile[1]}.json"


# Lit une tuile : d'abord en mémoire, sinon sur disque ; None si jamais téléchargée
def _load_tile(tile: tuple[int, int]) -> dict | None:
    if tile in _tile_cache:
        return _tile_cache[tile]
    path = _tile_path(tile)
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    _tile_cache[tile] = data
    return data


# Exécuté en arrière-plan : télécharge une tuile puis l'enregistre sur disque
def _download_tile(tile: tuple[int, int]) -> None:
    try:
        data = _fetch_tile(tile)
        if data is None:
            with _lock:
                _failed_at[tile] = time.monotonic()
            return
        _tile_path(tile).write_text(json.dumps(data))
        _tile_cache[tile] = data
        logger.info(
            f"Transports : {len(data['stops'])} arrêts, {len(data['routes'])} lignes, "
            f"{len(data['tram_lines'])} tronçons de tram pour la tuile {tile}."
        )
    finally:
        with _lock:
            _in_progress.discard(tile)


def _fetch_tile(tile: tuple[int, int]) -> dict | None:
    """Arrêts, lignes et voies de tram d'une tuile depuis Overpass."""
    s, w = tile[0] * TILE_DEG, tile[1] * TILE_DEG
    bbox = f"{s},{w},{s + TILE_DEG},{w + TILE_DEG}"
    # Requête Overpass en 3 parties :
    #   1. les arrêts de bus et de tram de la tuile
    #   2. les lignes (relations « route ») qui passent par ces arrêts
    #   3. le tracé des voies de tram de ces lignes (pour les dessiner sur la carte)
    query = f"""[out:json][timeout:60];
    (
      node["highway"="bus_stop"]({bbox});
      node["railway"="tram_stop"]({bbox});
      node["public_transport"]["tram"="yes"]({bbox});
      node["public_transport"]["bus"="yes"]({bbox});
    )->.stops;
    .stops out body;
    rel(bn.stops)["type"="route"]["route"~"^(tram|bus)$"]->.routes;
    .routes out body;
    way(r.routes)["railway"="tram"]({bbox});
    out geom;
    """
    for url in OVERPASS_URLS:
        try:
            resp = requests.post(url, data={"data": query}, headers=HEADERS, timeout=75)
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
        except Exception as e:
            logger.warning(f"Overpass {url} indisponible pour les transports ({e}).")
            continue
        return _parse(elements)
    return None


# Transforme la réponse d'Overpass en 3 listes simples : arrêts, lignes, voies de tram
def _parse(elements: list[dict]) -> dict:
    stops, routes, tram_lines = {}, {}, {}
    for el in elements:
        tags = el.get("tags", {})
        if el["type"] == "node":
            # Un nœud = un arrêt (tram ou bus)
            is_tram = tags.get("railway") == "tram_stop" or tags.get("tram") == "yes"
            stops[str(el["id"])] = {
                "id": str(el["id"]),
                "lat": el["lat"],
                "lon": el["lon"],
                "name": tags.get("name") or tags.get("name:fr") or ("Station de tram" if is_tram else "Arrêt de bus"),
                "kind": "tram" if is_tram else "bus",
            }
        elif el["type"] == "relation":
            # Une relation = une ligne : on garde la liste ordonnée de ses arrêts
            stop_ids = [
                str(m["ref"])
                for m in el.get("members", [])
                if m["type"] == "node" and (m.get("role") or "").startswith(("stop", "platform"))
            ]
            routes[str(el["id"])] = {
                "id": str(el["id"]),
                "mode": tags.get("route"),
                "ref": tags.get("ref") or "",
                "name": tags.get("name") or "",
                "colour": tags.get("colour") or "",
                "stop_ids": stop_ids,
            }
        elif el["type"] == "way" and el.get("geometry"):
            # Un way = un morceau de voie de tram : liste de points [lat, lon]
            tram_lines[str(el["id"])] = [[p["lat"], p["lon"]] for p in el["geometry"]]
    return {"stops": list(stops.values()), "routes": list(routes.values()), "tram_lines": tram_lines}


# Même logique que pour les lieux et les rues : cache, en cours, échec récent, sinon téléchargement
def ensure_tiles(tiles: list[tuple[int, int]]) -> str:
    """Lance le téléchargement des tuiles manquantes. Renvoie "ready", "loading", "unavailable" ou "zoom_in"."""
    if len(tiles) > MAX_TILES:
        return "zoom_in"
    missing = [t for t in tiles if _load_tile(t) is None]
    if not missing:
        return "ready"
    now = time.monotonic()
    with _lock:
        if any(t in _in_progress for t in missing):
            return "loading"
        if all(now - _failed_at.get(t, -RETRY_AFTER_SECONDS) < RETRY_AFTER_SECONDS for t in missing):
            return "unavailable"
        for t in missing:
            _in_progress.add(t)
            _executor.submit(_download_tile, t)
    return "loading"


# Réunit les données de plusieurs tuiles en une seule (sans doublons)
def _merged(tiles: list[tuple[int, int]]) -> dict:
    stops, routes, tram_lines = {}, {}, {}
    for t in tiles:
        data = _load_tile(t)
        if not data:
            continue
        stops.update({s["id"]: s for s in data["stops"]})
        for r in data["routes"]:
            # Une ligne qui traverse deux tuiles y apparaît deux fois, avec les mêmes membres
            routes.setdefault(r["id"], r)
        tram_lines.update(data["tram_lines"])
    return {"stops": stops, "routes": routes, "tram_lines": tram_lines}


# --- Carte ----------------------------------------------------------------------


def transit_layer(min_lat: float, min_lon: float, max_lat: float, max_lon: float, with_bus_stops: bool) -> dict:
    """Arrêts visibles et voies de tram de la zone, pour la couche « Bus et tram »."""
    tiles = tiles_for_bbox(min_lat, min_lon, max_lat, max_lon)
    status = ensure_tiles(tiles)
    if status == "zoom_in":
        return {"status": status, "stops": [], "tram_lines": []}
    data = _merged(tiles)

    # Pour chaque arrêt : la liste des lignes qui y passent (affichée dans l'infobulle)
    lines_by_stop: dict[str, set[str]] = {}
    for r in data["routes"].values():
        label = r["ref"] or r["name"]
        if label:
            for sid in r["stop_ids"]:
                lines_by_stop.setdefault(sid, set()).add(label)

    # Arrêts visibles à l'écran (les arrêts de bus seulement à partir du zoom 15, ils sont très nombreux)
    stops = [
        {**s, "lines": sorted(lines_by_stop.get(s["id"], set()))}
        for s in data["stops"].values()
        if min_lat <= s["lat"] <= max_lat and min_lon <= s["lon"] <= max_lon and (with_bus_stops or s["kind"] == "tram")
    ]
    return {"status": status, "stops": stops, "tram_lines": list(data["tram_lines"].values())}


# --- Trajet ---------------------------------------------------------------------


# Petites fonctions de calcul : minutes à pied, minutes en bus/tram, nom de ligne, point d'arrêt
def _walk_min(meters: float) -> float:
    return meters * DETOUR_FACTOR / WALK_SPEED_MS / 60


def _ride_min(mode: str, meters: float) -> float:
    return meters * RIDE_DETOUR / (RIDE_SPEED_KMH[mode] * 1000 / 60)


def _line_label(route: dict) -> str:
    return route["ref"] or route["name"] or ("Tram" if route["mode"] == "tram" else "Bus")


def _point(stop: dict) -> dict:
    return {"name": stop["name"], "lat": stop["lat"], "lon": stop["lon"]}


def transit_options(lat1: float, lon1: float, lat2: float, lon2: float) -> dict:
    """
    Itinéraires en bus / tram recommandés de A vers B, du plus rapide au plus lent :
    - une ligne, de l'arrêt le plus pratique près de A jusqu'à l'arrêt qui rapproche le plus de B,
      puis la fin à pied (une ligne « directe » est le cas où cette marche est courte) ;
    - ou deux lignes avec une correspondance.
    Seuls les itinéraires plus rapides que la marche sont gardés. Temps hors attente.
    """
    # Tuiles qui couvrent A, B et une marge (pour les arrêts proches)
    pad = MAX_STOP_DISTANCE_M / 111_000
    tiles = tiles_for_bbox(min(lat1, lat2) - pad, min(lon1, lon2) - pad, max(lat1, lat2) + pad, max(lon1, lon2) + pad)
    status = ensure_tiles(tiles)
    if status == "zoom_in":
        return {"status": "too_far", "options": [], "nearest_stop": None}
    data = _merged(tiles)
    stops = data["stops"]
    # Temps pour faire tout le trajet à pied : un itinéraire en bus/tram doit faire mieux
    walk_direct_min = _walk_min(straight_distance_m(lat1, lon1, lat2, lon2))

    # Distances utiles, calculées une fois par arrêt
    dist_a = {sid: straight_distance_m(lat1, lon1, s["lat"], s["lon"]) for sid, s in stops.items()}
    dist_b = {sid: straight_distance_m(lat2, lon2, s["lat"], s["lon"]) for sid, s in stops.items()}
    near_a = {sid: d for sid, d in dist_a.items() if d <= MAX_STOP_DISTANCE_M}

    # L'arrêt le plus proche de A (affiché même quand aucun itinéraire n'est trouvé)
    nearest_stop = None
    if near_a:
        sid = min(near_a, key=near_a.get)
        nearest_stop = {
            "name": stops[sid]["name"],
            "kind": stops[sid]["kind"],
            "distance_m": round(near_a[sid]),
            "walk_min": round(_walk_min(near_a[sid]), 1),
        }

    # Chaque ligne : ses arrêts connus dans l'ordre + la distance cumulée le long de la ligne
    profiles: dict[str, tuple[list[str], list[float]]] = {}
    routes_by_stop: dict[str, list[tuple[str, int]]] = {}
    routes = {rid: r for rid, r in data["routes"].items() if r["mode"] in RIDE_SPEED_KMH}
    for rid, r in routes.items():
        seq: list[str] = []
        for sid in r["stop_ids"]:
            if sid in stops and (not seq or seq[-1] != sid):
                seq.append(sid)
        if len(seq) < 2:
            continue
        cum = [0.0]
        for prev, cur in zip(seq, seq[1:], strict=False):
            a, b = stops[prev], stops[cur]
            cum.append(cum[-1] + straight_distance_m(a["lat"], a["lon"], b["lat"], b["lon"]))
        profiles[rid] = (seq, cum)
        for i, sid in enumerate(seq):
            routes_by_stop.setdefault(sid, []).append((rid, i))

    # Décrit une portion en bus/tram (ligne, arrêts de départ et d'arrivée, minutes, tracé)
    def ride_leg(rid: str, i: int, j: int) -> dict:
        r = routes[rid]
        seq, cum = profiles[rid]
        return {
            "type": "ride",
            "mode": r["mode"],
            "line": _line_label(r),
            "colour": r["colour"],
            "from": _point(stops[seq[i]]),
            "to": _point(stops[seq[j]]),
            "stops": j - i,
            "minutes": round(_ride_min(r["mode"], cum[j] - cum[i]), 1),
            "path": [[stops[sid]["lat"], stops[sid]["lon"]] for sid in seq[i : j + 1]],
        }

    # 1re ligne : meilleure arrivée possible à chaque arrêt (ligne, position) depuis A
    first: dict[tuple[str, int], tuple[float, int, float]] = {}
    for sid, d in near_a.items():
        for rid, i in routes_by_stop.get(sid, []):
            seq, cum = profiles[rid]
            mode = routes[rid]["mode"]
            start = _walk_min(d)
            for j in range(i + 1, len(seq)):
                if cum[j] - cum[i] < MIN_RIDE_M:
                    continue
                t = start + _ride_min(mode, cum[j] - cum[i])
                if t >= walk_direct_min:
                    break
                if (rid, j) not in first or t < first[(rid, j)][0]:
                    first[(rid, j)] = (t, i, d)

    # Meilleur itinéraire par combinaison de lignes (évite dix variantes de la même ligne)
    best: dict[tuple[str, ...], dict] = {}

    # Propose un itinéraire : gardé seulement s'il bat la marche et la meilleure variante déjà trouvée
    def offer(key: tuple[str, ...], total: float, legs: list[dict]) -> None:
        if legs[-1]["minutes"] > MAX_LAST_WALK_MIN:
            return
        if total < walk_direct_min and (key not in best or total < best[key]["total_min"]):
            best[key] = {"total_min": round(total, 1), "legs": legs}

    # Itinéraires à UNE ligne : marche -> bus/tram -> marche jusqu'à B
    for (rid, j), (t, i, d) in first.items():
        seq, _ = profiles[rid]
        end = seq[j]
        total = t + _walk_min(dist_b[end])
        offer(
            (_line_label(routes[rid]),),
            total,
            [
                {"type": "walk", "minutes": round(_walk_min(d), 1), "to": _point(stops[seq[i]])},
                ride_leg(rid, i, j),
                {"type": "walk", "minutes": round(_walk_min(dist_b[end]), 1), "to": {"lat": lat2, "lon": lon2}},
            ],
        )

    # Correspondances : depuis la meilleure arrivée à chaque arrêt, une 2e ligne à moins de 300 m
    arrival: dict[str, tuple[float, str, int, int, float]] = {}
    for (rid, j), (t, i, d) in first.items():
        sid = profiles[rid][0][j]
        if sid not in arrival or t < arrival[sid][0]:
            arrival[sid] = (t, rid, i, j, d)

    # Petite grille d'arrêts pour trouver rapidement les arrêts voisins (correspondances à pied)
    cell = 0.003  # ~300 m
    grid: dict[tuple[int, int], list[str]] = {}
    for sid, s in stops.items():
        if sid in routes_by_stop:
            grid.setdefault((math.floor(s["lat"] / cell), math.floor(s["lon"] / cell)), []).append(sid)

    for sid, (t1, rid1, i1, j1, d1) in arrival.items():
        if t1 + TRANSFER_PENALTY_MIN >= walk_direct_min:
            continue
        s = stops[sid]
        gi, gj = math.floor(s["lat"] / cell), math.floor(s["lon"] / cell)
        label1 = _line_label(routes[rid1])
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for sid2 in grid.get((gi + di, gj + dj), []):
                    s2 = stops[sid2]
                    dt = straight_distance_m(s["lat"], s["lon"], s2["lat"], s2["lon"])
                    if dt > TRANSFER_RADIUS_M:
                        continue
                    base = t1 + _walk_min(dt) + TRANSFER_PENALTY_MIN
                    for rid2, i2 in routes_by_stop[sid2]:
                        label2 = _line_label(routes[rid2])
                        if label2 == label1:
                            continue
                        seq2, cum2 = profiles[rid2]
                        mode2 = routes[rid2]["mode"]
                        for j2 in range(i2 + 1, len(seq2)):
                            if cum2[j2] - cum2[i2] < MIN_RIDE_M:
                                continue
                            t2 = base + _ride_min(mode2, cum2[j2] - cum2[i2])
                            if t2 >= walk_direct_min:
                                break
                            total = t2 + _walk_min(dist_b[seq2[j2]])
                            key = (label1, label2)
                            if key in best and total >= best[key]["total_min"]:
                                continue
                            offer(
                                key,
                                total,
                                [
                                    {
                                        "type": "walk",
                                        "minutes": round(_walk_min(d1), 1),
                                        "to": _point(stops[profiles[rid1][0][i1]]),
                                    },
                                    ride_leg(rid1, i1, j1),
                                    {
                                        "type": "walk",
                                        "minutes": round(_walk_min(dt), 1),
                                        "to": _point(s2),
                                        "transfer_min": TRANSFER_PENALTY_MIN,
                                    },
                                    ride_leg(rid2, i2, j2),
                                    {
                                        "type": "walk",
                                        "minutes": round(_walk_min(dist_b[seq2[j2]]), 1),
                                        "to": {"lat": lat2, "lon": lon2},
                                    },
                                ],
                            )

    # Résultat final : les meilleurs itinéraires, du plus rapide au plus lent,
    # avec le temps total de marche et le nombre de correspondances
    options = sorted(best.values(), key=lambda option: option["total_min"])[:MAX_OPTIONS]
    for option in options:
        option["walk_min"] = round(sum(leg["minutes"] for leg in option["legs"] if leg["type"] == "walk"), 1)
        option["transfers"] = sum(1 for leg in option["legs"] if leg["type"] == "ride") - 1
    return {"status": status, "options": options, "nearest_stop": nearest_stop}
