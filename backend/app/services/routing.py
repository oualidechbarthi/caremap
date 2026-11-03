"""
Temps de trajet entre deux points, par mode de transport, le long des vraies routes.

On interroge les serveurs OSRM publics d'OpenStreetMap (FOSSGIS) : un profil piéton,
un profil vélo et un profil voiture. La moto suit l'itinéraire de la voiture.
Si un serveur ne répond pas, on donne une estimation (ligne droite × détour ÷ vitesse
moyenne) et on le signale.
"""

import logging
import math
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache

import requests

logger = logging.getLogger("caremap-routing")

# Identification envoyée aux serveurs ; TIMEOUT_S = temps d'attente maximum par requête
HEADERS = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}
TIMEOUT_S = 8

# Profils OSRM publics (FOSSGIS). Le segment « driving » est le même pour tous les profils.
OSRM_SERVERS = {
    "foot": ["https://routing.openstreetmap.de/routed-foot/route/v1/driving"],
    "bike": ["https://routing.openstreetmap.de/routed-bike/route/v1/driving"],
    "car": [
        "https://routing.openstreetmap.de/routed-car/route/v1/driving",
        "https://router.project-osrm.org/route/v1/driving",
    ],
}

# Vitesse de marche de l'application (1,25 m/s), identique au reste du backend
WALK_SPEED_MS = 1.25
# Estimations de secours (km/h, moyennes urbaines) quand aucun serveur ne répond
FALLBACK_SPEED_KMH = {"walk": 4.5, "bike": 15.0, "motorcycle": 25.0, "car": 25.0}
DETOUR_FACTOR = 1.3

MODES = [
    # (mode affiché, profil OSRM)
    ("walk", "foot"),
    ("bike", "bike"),
    ("motorcycle", "car"),
    ("car", "car"),
]


# Formule de haversine : distance entre deux points sur une sphère (la Terre)
def straight_distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Distance à vol d'oiseau en mètres (haversine)."""
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


# OSRM décrit chaque étape (« tourner à gauche dans telle rue ») ; on garde l'essentiel
def _steps(route: dict) -> list[dict]:
    """Étapes de l'itinéraire (manœuvre, rue, distance) pour les instructions pas à pas."""
    steps = []
    for leg in route.get("legs", []):
        for step in leg.get("steps", []):
            maneuver = step.get("maneuver", {})
            steps.append(
                {
                    "type": maneuver.get("type", ""),
                    "modifier": maneuver.get("modifier", ""),
                    "exit": maneuver.get("exit"),
                    "name": step.get("name") or step.get("ref") or "",
                    "distance": round(step.get("distance", 0)),
                }
            )
    return steps


# lru_cache : un même trajet redemandé n'interroge pas le serveur une deuxième fois
@lru_cache(maxsize=512)
def _osrm_route(profile: str, lat1: float, lon1: float, lat2: float, lon2: float) -> dict | None:
    """Itinéraire OSRM (distance m, durée s, géométrie GeoJSON) ou None si aucun serveur ne répond."""
    # OSRM attend les coordonnées dans l'ordre longitude,latitude
    coords = f"{lon1},{lat1};{lon2},{lat2}"
    for base in OSRM_SERVERS[profile]:
        try:
            resp = requests.get(
                f"{base}/{coords}",
                # overview=full + geojson : le tracé complet de la route (dessiné sur la mini-carte « Y aller »)
                params={"overview": "full", "geometries": "geojson", "steps": "true"},
                headers=HEADERS,
                timeout=TIMEOUT_S,
            )
            resp.raise_for_status()
            data = resp.json()
            # Pas d'itinéraire trouvé sur ce serveur : on essaie le suivant
            if data.get("code") != "Ok" or not data.get("routes"):
                continue
            route = data["routes"][0]
            return {
                "distance": route["distance"],
                "duration": route["duration"],
                "geometry": route["geometry"],
                "steps": _steps(route),
            }
        except Exception as e:
            logger.warning(f"OSRM {profile} indisponible sur {base} ({e}).")
    return None


def trip_times(lat1: float, lon1: float, lat2: float, lon2: float) -> list[dict]:
    """Temps de trajet de (lat1, lon1) vers (lat2, lon2) pour chaque mode."""
    # Arrondi à ~1 m : réutilise le cache sans changer le résultat
    key = tuple(round(v, 5) for v in (lat1, lon1, lat2, lon2))
    # Les 3 profils (pied, vélo, voiture) sont demandés EN MÊME TEMPS (en parallèle)
    # pour que l'utilisateur attende une seule fois au lieu de trois.
    profiles = sorted({profile for _, profile in MODES})
    with ThreadPoolExecutor(max_workers=len(profiles)) as pool:
        results = dict(zip(profiles, pool.map(lambda p: _osrm_route(p, *key), profiles), strict=True))

    # Pour chaque mode : temps réel si le serveur a répondu, sinon estimation
    straight = straight_distance_m(lat1, lon1, lat2, lon2)
    trips = []
    for mode, profile in MODES:
        route = results.get(profile)
        if route:
            duration_s = route["duration"]
            # Marche : même vitesse que tout le reste de l'application
            if mode == "walk":
                duration_s = route["distance"] / WALK_SPEED_MS
            trips.append(
                {
                    "mode": mode,
                    "method": "route",
                    "distance_m": round(route["distance"]),
                    "duration_min": round(duration_s / 60, 1),
                    "geometry": route["geometry"],
                    "steps": route["steps"],
                }
            )
        # Estimation : distance en ligne droite × 1,3 (détours) ÷ vitesse moyenne du mode
        else:
            distance = straight * DETOUR_FACTOR
            speed_m_per_min = FALLBACK_SPEED_KMH[mode] * 1000 / 60
            trips.append(
                {
                    "mode": mode,
                    "method": "estimate",
                    "distance_m": round(distance),
                    "duration_min": round(distance / speed_m_per_min, 1),
                    "geometry": {"type": "LineString", "coordinates": [[lon1, lat1], [lon2, lat2]]},
                    "steps": [],
                }
            )
    return trips
