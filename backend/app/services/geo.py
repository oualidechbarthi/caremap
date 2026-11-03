# ==============================================================================
# geo.py : les calculs géographiques de base.
#   - distance parcourue à pied en N minutes
#   - agrandir un rectangle de carte de N mètres
#   - télécharger les lieux depuis OpenStreetMap (API Overpass)
#   - calculer les « déserts » du mode « Toute la zone »
# ==============================================================================
import json
import logging
import math

import geopandas as gpd
import requests
from shapely.geometry import Point, box
from shapely.ops import unary_union

logger = logging.getLogger("caremap-geo")

# Serveurs Overpass publics, essayés dans l'ordre (ils sont souvent saturés)
OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

# Vitesse de marche moyenne d'un piéton (4,5 km/h)
WALKING_SPEED_M_PER_S = 1.25


def walk_radius_meters(minutes: int) -> float:
    """Distance parcourue à pied en `minutes` minutes (15 min ≈ 1125 m)."""
    return minutes * 60 * WALKING_SPEED_M_PER_S


# Utile pour prendre en compte les services juste à l'extérieur de l'écran.
# 1 degré de latitude ≈ 111 320 m partout ; 1 degré de longitude est plus court
# quand on s'éloigne de l'équateur (multiplié par cos(latitude)).
def pad_bbox(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float, meters: float
) -> tuple[float, float, float, float]:
    """Agrandit une bbox de `meters` mètres de chaque côté (approximation sphérique)."""
    dlat = meters / 111_320
    mid_lat = math.radians((min_lat + max_lat) / 2)
    dlon = meters / (111_320 * max(math.cos(mid_lat), 0.01))
    return min_lat - dlat, min_lon - dlon, max_lat + dlat, max_lon + dlon


def fetch_osm_amenities_live(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> list[dict] | None:
    """
    Interroge OpenStreetMap (Overpass) pour la zone donnée.
    Renvoie la liste des commodités, ou None si le service est injoignable
    (pour ne pas marquer la zone comme déjà téléchargée).
    """
    bbox = f"{min_lat},{min_lon},{max_lat},{max_lon}"
    # nwr = nodes + ways + relations : beaucoup de supermarchés/hôpitaux sont dessinés comme bâtiments
    # Requête écrite en langage Overpass QL : pharmacies, santé (clinique, médecin,
    # hôpital) et alimentation (supermarché, boulangerie, épicerie...) dans le rectangle.
    # « out center tags » : renvoie le centre de chaque lieu et ses informations (tags).
    query = f"""[out:json][timeout:20];
    (
      nwr["amenity"="pharmacy"]({bbox});
      nwr["amenity"~"^(clinic|doctors|hospital)$"]({bbox});
      nwr["shop"~"^(supermarket|bakery|grocery|convenience|greengrocer)$"]({bbox});
    );
    out center tags;
    """
    # Les serveurs OSM demandent de s'identifier avec un User-Agent clair
    headers = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}
    elements = None
    # On essaie chaque serveur jusqu'à ce qu'un réponde (break = on s'arrête au premier qui marche)
    for overpass_url in OVERPASS_URLS:
        try:
            resp = requests.post(overpass_url, data={"data": query}, headers=headers, timeout=40)
            resp.raise_for_status()
            elements = resp.json().get("elements", [])
            break
        except Exception as e:
            logger.warning(f"Overpass {overpass_url} unavailable ({e}).")
    if elements is None:
        return None

    # Transformation des éléments OSM en lieux simples pour notre base
    results = []
    for el in elements:
        tags = el.get("tags", {})
        # Les nodes ont lat/lon, les ways/relations ont un "center"
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None or lon is None:
            continue

        # Classement en 3 catégories selon les tags OSM
        if tags.get("amenity") == "pharmacy":
            cat, label = "pharmacy", "Pharmacie"
        elif tags.get("amenity") in ["clinic", "doctors", "hospital"]:
            cat, label = "healthcare", "Santé & Soins"
        else:
            cat, label = "food", "Alimentation"

        # Adresse construite à partir du numéro et de la rue (souvent absents au Maroc)
        street = tags.get("addr:street", "")
        number = tags.get("addr:housenumber", "")
        results.append(
            {
                "name": tags.get("name", label),
                "category": cat,
                "category_label": label,
                "address": f"{number} {street}".strip(),
                "latitude": lat,
                "longitude": lon,
                # Format OSM, ex. « Mo-Sa 09:00-21:00 » ; vide quand il n'est pas renseigné
                "opening_hours": tags.get("opening_hours", ""),
            }
        )
    return results


# Principe : on dessine un cercle de « rayon de marche » autour de chaque service.
# Tout ce qui, dans la vue, n'est couvert par AUCUN cercle est un désert.
def calculate_deserts_on_the_fly(
    amenities: list[dict], min_lat: float, min_lon: float, max_lat: float, max_lon: float, minutes: int = 15
) -> tuple[list[dict], float]:
    """
    Calcule la zone accessible en `minutes` minutes à pied autour des commodités
    et en déduit les « déserts » de services dans la vue visible.
    Returns: (desert_features_list, desert_percentage)
    """
    desert_features = []
    desert_pct = 0.0
    radius = walk_radius_meters(minutes)

    try:
        # Rectangle de la vue (en latitude/longitude, système EPSG:4326 = GPS)
        viewport_wgs84 = box(min_lon, min_lat, max_lon, max_lat)
        viewport_series = gpd.GeoSeries([viewport_wgs84], crs="EPSG:4326")
        # Projection UTM locale : distances en vrais mètres (Web Mercator les déforme de 1/cos(lat))
        local_crs = viewport_series.estimate_utm_crs()
        viewport_proj = viewport_series.to_crs(local_crs).iloc[0]
        # Surface totale de la vue, en m²
        total_viewport_area = viewport_proj.area

        if amenities and total_viewport_area > 0:
            points_geom = [Point(float(item["longitude"]), float(item["latitude"])) for item in amenities]
            points_proj = gpd.GeoSeries(points_geom, crs="EPSG:4326").to_crs(local_crs)
            # buffer(radius) = cercle autour de chaque point ; unary_union = fusion de tous les cercles
            accessible_zone = unary_union(points_proj.buffer(radius, resolution=12))
            # Désert = vue MOINS zone accessible ; pourcentage = surface du désert / surface de la vue
            desert_proj = viewport_proj.difference(accessible_zone)
            desert_pct = round((desert_proj.area / total_viewport_area) * 100, 1)
        else:
            # Aucun service dans la zone : désert total
            desert_proj = viewport_proj
            desert_pct = 100.0

        if not desert_proj.is_empty:
            # Simplification légère (5 m) pour alléger le GeoJSON envoyé au navigateur
            desert_wgs84 = gpd.GeoSeries([desert_proj.simplify(5)], crs=local_crs).to_crs("EPSG:4326")
            # Le désert est renvoyé en GeoJSON ; « severity » = critique si plus de 40 % de la vue
            desert_features.append(
                {
                    "type": "Feature",
                    "geometry": json.loads(desert_wgs84.to_json())["features"][0]["geometry"],
                    "properties": {
                        "name": f"Désert de services (> {minutes} min à pied)",
                        "severity": "critical" if desert_pct > 40 else "medium",
                        "desert_percentage": desert_pct,
                    },
                }
            )
    # En cas d'erreur de calcul, on renvoie simplement « pas de désert » plutôt que de planter
    except Exception as err:
        logger.error(f"On-the-fly geometry calculation error: {err}")

    return desert_features, desert_pct
