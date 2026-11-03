"""
Analyse d'accessibilité par hexagones H3, pondérée par la population.

La zone visible est découpée en hexagones H3 de résolution 9 (~0,1 km², ~350 m de large).
Pour chaque hexagone :
- le temps de marche jusqu'au service le plus proche de chaque catégorie
  (distance en ligne droite × 1,3 de détour, à 4,5 km/h, comme le reste de l'application) ;
- le temps pour avoir les trois services (le plus long des trois) : c'est le critère
  de la « ville du quart d'heure » ;
- sa population (Kontur, hexagones de résolution 8 répartis entre leurs 7 enfants).

On en tire combien d'habitants vivent à plus de N minutes d'un service essentiel,
et les zones prioritaires : les hexagones les plus peuplés parmi les mal desservis.
"""

import math

import h3
import numpy as np

# Résolution H3 : plus le nombre est grand, plus les hexagones sont petits (9 ≈ 350 m de large)
ANALYSIS_RESOLUTION = 9
# Au-delà de 4000 hexagones, la vue est trop grande : on demande de zoomer
MAX_CELLS = 4000
DETOUR_FACTOR = 1.3
WALK_M_PER_MIN = 75  # 1,25 m/s
CATEGORIES = ("pharmacy", "healthcare", "food")
# Nombre de « zones prioritaires » affichées dans le panneau
TOP_PRIORITY = 5


def _project(lats: np.ndarray, lons: np.ndarray, lat0: float) -> tuple[np.ndarray, np.ndarray]:
    """Projection plane locale en mètres (suffisante à l'échelle d'une ville)."""
    # 1° de longitude = 111 320 m × cos(latitude) ; 1° de latitude ≈ 110 540 m
    return lons * 111_320 * math.cos(math.radians(lat0)), lats * 110_540


def _nearest_minutes(cx: np.ndarray, cy: np.ndarray, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """Temps de marche (min) de chaque centre d'hexagone au point le plus proche."""
    if len(px) == 0:
        return np.full(len(cx), np.inf)
    # Pour chaque centre d'hexagone, on calcule la distance à TOUS les services d'un coup
    # (calcul vectorisé NumPy, très rapide) et on garde la plus petite.
    best = np.empty(len(cx))
    for start in range(0, len(cx), 512):  # par paquets : mémoire maîtrisée
        dx = cx[start : start + 512, None] - px[None, :]
        dy = cy[start : start + 512, None] - py[None, :]
        best[start : start + 512] = np.sqrt(dx * dx + dy * dy).min(axis=1)
    # Distance à vol d'oiseau × 1,3 (détours des rues) ÷ 75 m/min = minutes de marche
    return best * DETOUR_FACTOR / WALK_M_PER_MIN


# Tous les hexagones H3 dont le centre est dans le rectangle de la vue
def cells_for_bbox(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> list[str]:
    box = h3.LatLngPoly([(min_lat, min_lon), (min_lat, max_lon), (max_lat, max_lon), (max_lat, min_lon)])
    return list(h3.polygon_to_cells(box, ANALYSIS_RESOLUTION))


def cell_population(cell: str, population: dict | None) -> float | None:
    """Population d'un hexagone de résolution 9 à partir des données Kontur."""
    if not population:
        return None
    # Les données Kontur sont en hexagones de résolution 8 (~400 m), plus grands que les nôtres (9).
    # Un hexagone de résolution 8 contient 7 hexagones de résolution 9 : on partage sa population.
    pop_res, cells = population["resolution"], population["cells"]
    if pop_res == ANALYSIS_RESOLUTION:
        return cells.get(cell, 0.0)
    if pop_res < ANALYSIS_RESOLUTION:
        parent = h3.cell_to_parent(cell, pop_res)
        # Hypothèse : population répartie également entre les 7^(écart) enfants
        return cells.get(parent, 0.0) / 7 ** (ANALYSIS_RESOLUTION - pop_res)
    return sum(cells.get(child, 0.0) for child in h3.cell_to_children(cell, pop_res))


# Arrondi à 0,1 minute ; None si aucun service n'a été trouvé (distance infinie)
def _rounded(value: float) -> float | None:
    return None if not math.isfinite(value) else round(float(value), 1)


def analyze_area(
    min_lat: float,
    min_lon: float,
    max_lat: float,
    max_lon: float,
    amenities: list[dict],
    minutes: int,
    population: dict | None,
) -> dict:
    """Hexagones (GeoJSON) avec temps d'accès et population, et synthèse de la zone."""
    cells = cells_for_bbox(min_lat, min_lon, max_lat, max_lon)
    if len(cells) > MAX_CELLS:
        return {"status": "zoom_in", "cells": len(cells)}
    if not cells:
        return {"status": "ready", "hexagons": {"type": "FeatureCollection", "features": []}, "summary": None}

    # Centre (lat, lon) de chaque hexagone, converti en mètres
    centers = np.array([h3.cell_to_latlng(c) for c in cells])
    lat0 = float(centers[:, 0].mean())
    cx, cy = _project(centers[:, 0], centers[:, 1], lat0)

    # Temps de marche vers le service le plus proche, pour chaque catégorie
    times = {}
    for cat in CATEGORIES:
        pts = [(a["latitude"], a["longitude"]) for a in amenities if a.get("category") == cat]
        arr = np.array(pts, dtype=float).reshape(-1, 2)
        px, py = _project(arr[:, 0], arr[:, 1], lat0)
        times[cat] = _nearest_minutes(cx, cy, px, py)
    # Les trois services réunis : il faut atteindre le plus éloigné des trois
    all_three = np.maximum.reduce([times[c] for c in CATEGORIES])

    # Population de chaque hexagone (None si les données d'habitants ne sont pas disponibles)
    pops = [cell_population(c, population) for c in cells]
    has_pop = population is not None

    # Parcours de tous les hexagones : on additionne les habitants couverts / non couverts
    # et on construit le GeoJSON qui sera dessiné sur la carte
    features = []
    total = covered = 0.0
    beyond = dict.fromkeys(CATEGORIES, 0.0)
    priority = []
    for i, cell in enumerate(cells):
        pop = pops[i] or 0.0
        # missing = services trop loin depuis cet hexagone (ex. ["pharmacy"])
        missing = [c for c in CATEGORIES if not times[c][i] <= minutes]
        total += pop
        if not missing:
            covered += pop
        for cat in missing:
            beyond[cat] += pop
        # Hexagone habité et mal desservi : candidat pour les « zones prioritaires »
        if missing and pop > 0:
            priority.append((pop, cell, missing, all_three[i]))

        # Les 6 sommets de l'hexagone ; on répète le premier pour fermer le polygone (règle GeoJSON)
        ring = [[lng, lat] for lat, lng in h3.cell_to_boundary(cell)]
        ring.append(ring[0])
        features.append(
            {
                "type": "Feature",
                "geometry": {"type": "Polygon", "coordinates": [ring]},
                "properties": {
                    "h3": cell,
                    "population": round(pop) if has_pop else None,
                    "t_pharmacy": _rounded(times["pharmacy"][i]),
                    "t_healthcare": _rounded(times["healthcare"][i]),
                    "t_food": _rounded(times["food"][i]),
                    "t_all": _rounded(all_three[i]),
                    "missing": missing,
                },
            }
        )

    # Zones prioritaires : les hexagones mal desservis les plus peuplés en premier
    priority.sort(reverse=True)
    # Résumé affiché dans le panneau « Population de la zone visible »
    summary = {
        "minutes": minutes,
        "cells": len(cells),
        "area_km2": round(len(cells) * h3.average_hexagon_area(ANALYSIS_RESOLUTION, "km^2"), 1),
        "cells_covered": int(sum(1 for i in range(len(cells)) if all_three[i] <= minutes)),
        "population_known": has_pop,
        "population_total": round(total) if has_pop else None,
        "population_covered": round(covered) if has_pop else None,
        "population_desert": round(total - covered) if has_pop else None,
        "population_beyond": {c: round(v) for c, v in beyond.items()} if has_pop else None,
        "priority": [
            {
                "h3": cell,
                "lat": h3.cell_to_latlng(cell)[0],
                "lon": h3.cell_to_latlng(cell)[1],
                "population": round(pop),
                "missing": missing,
                "t_all": _rounded(t),
            }
            for pop, cell, missing, t in priority[:TOP_PRIORITY]
        ],
    }
    return {"status": "ready", "hexagons": {"type": "FeatureCollection", "features": features}, "summary": summary}
