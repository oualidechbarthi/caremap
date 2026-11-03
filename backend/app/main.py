# ==============================================================================
# main.py : le point d'entrée du backend (l'API FastAPI de CareMap).
#
# Ce fichier ne fait presque pas de calcul lui-même : il reçoit les requêtes
# du frontend (React), appelle les bons « services » (dossier app/services/)
# et renvoie le résultat en JSON / GeoJSON.
#
# Les adresses (endpoints) de l'API :
#   /api/health    -> le serveur et la base fonctionnent-ils ?
#   /api/locate    -> pays / ville approximatifs à partir de l'adresse IP
#   /api/search    -> recherche d'une ville ou d'une adresse (barre de recherche)
#   /api/explore   -> mode « Toute la zone » : services + déserts de la vue
#   /api/nearby    -> mode « Autour de moi » : ce qui est atteignable à pied
#   /api/trip      -> temps de trajet (pied, vélo, moto, voiture, bus/tram)
#   /api/transit   -> couche « Bus et tram » (arrêts et lignes de tram)
#   /api/analysis  -> couche « Population (H3) » : hexagones et habitants (comptes pro)
#   /api/auth/...  -> comptes : inscription, connexion, compte connecté
# ==============================================================================

# --- Bibliothèques standard de Python ---
import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

# --- Bibliothèques installées (requirements.txt) ---
# FastAPI : le framework web. Shapely : calculs de formes géographiques (polygones).
from typing import Literal

from fastapi import Depends, FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from shapely.geometry import box, mapping

# --- Nos propres modules ---
# db.py : tout ce qui touche à la base SQLite (cache des lieux OpenStreetMap)
# services/ : chaque fichier s'occupe d'un sujet (analyse H3, géo, rues, IP, population, trajets, transports)
from app.db import (
    DB_PATH,
    bbox_of_cells,
    cells_for_bbox,
    get_amenities_in_bbox,
    get_db_connection,
    get_missing_cells,
    init_db,
    mark_cells_fetched,
    save_amenities,
)
from app.services.analysis import analyze_area
from app.services.auth import current_user, init_users_table, login, register, require_pro
from app.services.geo import calculate_deserts_on_the_fly, fetch_osm_amenities_live, pad_bbox, walk_radius_meters
from app.services.isochrone import download_streets, find_streets, straight_line_area, street_area, streets_key
from app.services.location import detect_location_by_ip, search_places
from app.services.population import population_for
from app.services.routing import trip_times
from app.services.transit import transit_layer, transit_options

# Journal (logs) : chaque message affiché par le backend aura la date et le niveau (INFO, WARNING...)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("caremap-api")


class _HidePrivateData(logging.Filter):
    """
    Confidentialité : les logs d'accès d'uvicorn afficheraient l'adresse IP du visiteur et
    l'URL complète, qui contient sa position (?lat=...&lon=...). On garde seulement le chemin
    (/api/nearby) et on masque l'IP : le serveur n'enregistre jamais où sont les gens.
    """

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, tuple) and len(record.args) >= 3:
            args = list(record.args)
            args[0] = "-"  # adresse IP du visiteur
            args[2] = str(args[2]).split("?", 1)[0]  # URL sans les paramètres (positions)
            record.args = tuple(args)
        return True


logging.getLogger("uvicorn.access").addFilter(_HidePrivateData())


# « lifespan » : code exécuté une fois au démarrage du serveur (avant le yield)
# et une fois à l'arrêt (après le yield). Ici on crée les tables SQLite si besoin.
@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialise la base SQLite au démarrage."""
    init_db()
    init_users_table()  # table des comptes (services/auth.py)
    yield


# Création de l'application FastAPI. Le titre et la description apparaissent
# dans la documentation automatique : http://localhost:8000/docs
app = FastAPI(
    title="CareMap API",
    description="API live : Détection des déserts urbains et géolocalisation IP / GPS en temps réel.",
    version="1.0.0",
    lifespan=lifespan,
)

# Configuration CORS pour autoriser l'application Vite / React
app.add_middleware(
    CORSMiddleware,
    # CORS : par sécurité, un navigateur bloque les appels d'un site vers un autre.
    # On autorise ici le frontend de développement (Vite, port 5173) à appeler l'API.
    # (En Docker, nginx sert le frontend et l'API sur la même adresse : pas besoin de CORS.)
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==============================================================================
# ENDPOINTS DE L'API LIVE
# ==============================================================================


# @app.get(...) relie une adresse (URL) à la fonction juste en dessous.
# Ici : GET /api/health -> health_check(). Utilisé par le HEALTHCHECK de Docker.
@app.get("/api/health")
def health_check() -> dict:
    """1. Vérification d'état du serveur et de SQLite."""
    # On compte les lieux enregistrés dans le cache pour vérifier que SQLite répond
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) AS total FROM amenities;")
        total = cursor.fetchone()["total"]

    return {
        "status": "healthy",
        "mode": "live on-the-fly",
        "database": str(DB_PATH),
        "cached_amenities": total,
    }


# Position approximative du visiteur, utilisée seulement pour centrer la carte
# sur son pays à la première visite (jamais comme position exacte).
@app.get("/api/locate")
def locate_user(request: Request) -> dict:
    """2. Détecte le pays et la ville de l'utilisateur (sans demander d'autorisation GPS)."""
    # Derrière Caddy et nginx, la vraie IP du visiteur est la première de X-Forwarded-For
    forwarded = request.headers.get("x-forwarded-for", "")
    client_ip = forwarded.split(",")[0].strip() if forwarded else (request.client.host if request.client else None)
    return detect_location_by_ip(client_ip)


# Query(...) : paramètre obligatoire dans l'URL (?q=...), d'au moins 2 caractères
@app.get("/api/search")
def search(q: str = Query(..., min_length=2, description="Ville, quartier ou adresse")) -> dict:
    """3. Recherche d'un lieu pour y déplacer la carte."""
    return {"results": search_places(q)}


# Au-delà de ce nombre de cellules (~2 km) la vue est trop large pour interroger OSM
# ------------------------------------------------------------------------------
# Téléchargement des lieux OpenStreetMap (OSM) par « cellules »
# La carte est découpée en carrés (cellules, voir db.py). Chaque cellule n'est
# téléchargée qu'une seule fois puis gardée dans SQLite.
# ------------------------------------------------------------------------------
MAX_CELLS_PER_FETCH = 30
# Délai avant de réessayer une zone dont le téléchargement a échoué
RETRY_AFTER_SECONDS = 60

# Téléchargements OSM en arrière-plan : Overpass peut mettre 30 s à répondre,
# on ne bloque donc jamais la réponse de /api/explore.
# Deux files séparées : les lieux (petits, rapides) ne doivent jamais attendre
# derrière un téléchargement de rues (lourd, jusqu'à ~3 min si Overpass est lent).
_osm_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="osm-places")
_streets_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="osm-streets")
# Verrou : plusieurs requêtes arrivent en même temps, il protège les variables
# ci-dessous pour éviter de lancer deux fois le même téléchargement.
_osm_lock = threading.Lock()
# Cellules en cours de téléchargement
_cells_in_progress: set[tuple[int, int]] = set()
# Cellule -> moment de son dernier échec (pour attendre avant de réessayer)
_cells_failed_at: dict[tuple[int, int], float] = {}


# Exécuté en arrière-plan (dans un thread) : télécharge les lieux des cellules
# manquantes depuis Overpass, les enregistre, puis marque les cellules « faites ».
def _download_cells(cells: list[tuple[int, int]]) -> None:
    try:
        # Une seule requête Overpass pour le rectangle qui englobe toutes les cellules
        live_points = fetch_osm_amenities_live(*bbox_of_cells(cells))
        # None = Overpass n'a pas répondu : on note l'échec pour réessayer plus tard
        if live_points is None:
            with _osm_lock:
                _cells_failed_at.update({cell: time.monotonic() for cell in cells})
            return
        save_amenities(live_points)
        mark_cells_fetched(cells)
        logger.info(f"OSM : {len(live_points)} commodités chargées pour {len(cells)} cellule(s).")
    # « finally » s'exécute toujours, même en cas d'erreur : la cellule n'est plus « en cours »
    finally:
        with _osm_lock:
            _cells_in_progress.difference_update(cells)


def ensure_osm_data(min_lat: float, min_lon: float, max_lat: float, max_lon: float, zoom: int) -> str:
    """
    Lance (si besoin) le téléchargement OSM des cellules manquantes de la zone.
    Renvoie l'état des données : "ready", "loading", "unavailable" ou "zoom_in".
    """
    # 1. Quelles cellules de la zone ne sont pas encore dans le cache ?
    missing = get_missing_cells(cells_for_bbox(min_lat, min_lon, max_lat, max_lon))
    if not missing:
        return "ready"
    # 2. Vue trop large (ville entière, pays...) : on demande à l'utilisateur de zoomer
    if zoom < 13 or len(missing) > MAX_CELLS_PER_FETCH:
        return "zoom_in"

    # 3. Déjà en cours ? Échec récent ? Sinon on réserve les cellules et on lance le téléchargement
    now = time.monotonic()
    with _osm_lock:
        if any(cell in _cells_in_progress for cell in missing):
            return "loading"
        if all(now - _cells_failed_at.get(cell, -RETRY_AFTER_SECONDS) < RETRY_AFTER_SECONDS for cell in missing):
            return "unavailable"
        _cells_in_progress.update(missing)

    # submit() lance la fonction en arrière-plan et rend la main tout de suite :
    # la réponse part immédiatement avec "loading" et le frontend redemandera plus tard.
    _osm_executor.submit(_download_cells, missing)
    return "loading"


# GeoJSON = format standard pour les données de carte (Leaflet le lit directement).
# Attention : en GeoJSON les coordonnées sont dans l'ordre [longitude, latitude].
def amenity_feature(item: dict, **extra) -> dict:
    """Commodité SQLite → Feature GeoJSON."""
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [float(item["longitude"]), float(item["latitude"])]},
        "properties": {
            "id": item["id"],
            "name": item["name"],
            "category": item["category"],
            "category_label": item["category_label"],
            "address": item.get("address", ""),
            "opening_hours": item.get("opening_hours") or "",
            **extra,
        },
    }


# Appelé par le frontend à chaque déplacement / zoom de la carte en mode « Toute la zone ».
# min_lat, min_lon, max_lat, max_lon = le rectangle visible à l'écran.
@app.get("/api/explore")
def explore_map_viewport(
    min_lat: float = Query(..., description="Latitude sud"),
    min_lon: float = Query(..., description="Longitude ouest"),
    max_lat: float = Query(..., description="Latitude nord"),
    max_lon: float = Query(..., description="Longitude est"),
    category: str = Query("all", description="Filtre catégorie ('all', 'pharmacy', 'healthcare', 'food')"),
    zoom: int = Query(14, description="Niveau de zoom actuel"),
    pad: bool = Query(True, description="Élargir la zone du rayon de marche (inutile en mode « Autour de moi »)"),
    minutes: int = Query(15, ge=5, le=30, description="Temps de marche maximal (minutes)"),
) -> dict:
    """
    4. Calcul en direct lors de la navigation (pan/zoom) :
       - Lance en arrière-plan le téléchargement OSM de la zone si besoin (cache SQLite)
       - Calcule les déserts à la volée (Shapely)
       - Renvoie le GeoJSON des points et des zones d'alerte
    """
    # Distance (en mètres) que l'on parcourt à pied en `minutes`
    radius = walk_radius_meters(minutes)
    # Les services juste hors de l'écran desservent aussi les bords de la vue
    padded = pad_bbox(min_lat, min_lon, max_lat, max_lon, radius) if pad else (min_lat, min_lon, max_lat, max_lon)

    # Vérifie le cache et lance le téléchargement en arrière-plan si nécessaire
    osm_status = ensure_osm_data(*padded, zoom=zoom)

    # Lieux de la zone élargie (pour le calcul) puis seulement ceux visibles (pour l'affichage)
    nearby = get_amenities_in_bbox(*padded, category=category)
    amenities = [a for a in nearby if min_lat <= a["latitude"] <= max_lat and min_lon <= a["longitude"] <= max_lon]

    # Déserts = parties de la vue à plus de `minutes` de marche de tout service
    desert_features, desert_pct = calculate_deserts_on_the_fly(nearby, min_lat, min_lon, max_lat, max_lon, minutes)

    amenity_features = [amenity_feature(item) for item in amenities]

    # Réponse envoyée au frontend : état du téléchargement, statistiques, points et déserts
    return {
        "osm_status": osm_status,
        "viewport": {"min_lat": min_lat, "min_lon": min_lon, "max_lat": max_lat, "max_lon": max_lon, "zoom": zoom},
        "stats": {
            "total_amenities": len(amenities),
            "pharmacies": sum(1 for a in amenities if a.get("category") == "pharmacy"),
            "healthcare": sum(1 for a in amenities if a.get("category") == "healthcare"),
            "food": sum(1 for a in amenities if a.get("category") == "food"),
            "desert_percentage": desert_pct,
            "walk_minutes": minutes,
            "walk_radius_m": round(radius),
        },
        "amenities": {"type": "FeatureCollection", "features": amenity_features},
        "deserts": {"type": "FeatureCollection", "features": desert_features},
    }


# ==============================================================================
# MODE « AUTOUR DE MOI » : ce que je peux atteindre à pied depuis ma position
# ==============================================================================

# Même principe que pour les lieux : quartiers dont les rues sont en cours / en échec
_streets_in_progress: set[tuple[float, float, int]] = set()
_streets_failed_at: dict[tuple[float, float, int], float] = {}
# Les rues sont toujours téléchargées pour le trajet le plus long (30 min) :
# un seul téléchargement par quartier, réutilisé pour toutes les positions du curseur.
STREETS_DOWNLOAD_MINUTES = 30


# Exécuté en arrière-plan : télécharge le réseau de rues piétonnes d'un quartier
def _download_streets(key: tuple[float, float, int]) -> None:
    try:
        if not download_streets(key):
            with _osm_lock:
                _streets_failed_at[key] = time.monotonic()
    finally:
        with _osm_lock:
            _streets_in_progress.discard(key)


# Vérifie si les rues autour de la position sont en cache (dossier data/streets/)
def ensure_streets(lat: float, lon: float, minutes: int) -> str:
    """Lance si besoin le téléchargement des rues. Renvoie "ready", "loading" ou "unavailable"."""
    if find_streets(lat, lon, minutes):
        return "ready"
    # Toujours la taille maximale : changer le temps de marche ne relance pas de téléchargement
    key = streets_key(lat, lon, max(minutes, STREETS_DOWNLOAD_MINUTES))
    with _osm_lock:
        # Un téléchargement déjà en cours pour ce quartier suffit (pas de doublon)
        if any(running[:2] == key[:2] for running in _streets_in_progress):
            return "loading"
        if time.monotonic() - _streets_failed_at.get(key, -RETRY_AFTER_SECONDS) < RETRY_AFTER_SECONDS:
            return "unavailable"
        _streets_in_progress.add(key)
    _streets_executor.submit(_download_streets, key)
    return "loading"


# Appelé en mode « Autour de moi » avec la position de l'utilisateur (lat, lon).
@app.get("/api/nearby")
def explore_around_me(
    lat: float = Query(..., description="Latitude de ma position"),
    lon: float = Query(..., description="Longitude de ma position"),
    minutes: int = Query(15, ge=5, le=30, description="Temps de marche maximal (minutes)"),
    category: str = Query("all", description="Filtre catégorie ('all', 'pharmacy', 'healthcare', 'food')"),
) -> dict:
    """
    5. Ce que je peux atteindre à pied en `minutes` depuis ma position :
       - la zone atteignable (le long des rues si elles sont en cache, sinon estimation)
       - chaque service avec son temps de marche, marqué atteignable ou non
       - le service le plus proche de chaque catégorie
       - un masque « désert » : tout ce qui est hors de portée
    """
    radius = walk_radius_meters(minutes)
    # Carré de recherche autour de la position (un peu plus grand que le rayon de marche)
    search_box = pad_bbox(lat, lon, lat, lon, radius * 1.3)
    osm_status = ensure_osm_data(*search_box, zoom=16)
    streets_status = ensure_streets(lat, lon, minutes)

    # Zone atteignable : précise (le long des rues) si les rues sont prêtes,
    # sinon une estimation (cercle à vol d'oiseau) en attendant le téléchargement.
    area = street_area(lat, lon, minutes) if streets_status == "ready" else None
    if area is None:
        area = straight_line_area(lat, lon, minutes)

    # Temps de marche réel vers chaque lieu, puis tri du plus proche au plus loin
    candidates = get_amenities_in_bbox(*search_box)
    walk_meters = area.walk_meters([a["latitude"] for a in candidates], [a["longitude"] for a in candidates])
    for item, meters in zip(candidates, walk_meters, strict=True):
        # mètres ÷ (mètres par minute) = minutes de marche
        item["walk_minutes"] = round(meters / (radius / minutes), 1)
        item["reachable"] = bool(meters <= radius)
    candidates.sort(key=lambda a: a["walk_minutes"])

    # Le lieu atteignable le plus proche pour chaque catégorie (affiché dans le panneau)
    nearest = {}
    for cat in ("pharmacy", "healthcare", "food"):
        best = next((a for a in candidates if a["category"] == cat and a["reachable"]), None)
        nearest[cat] = {"id": best["id"], "name": best["name"], "walk_minutes": best["walk_minutes"]} if best else None

    # Filtre de catégorie choisi dans l'interface (Tous / Pharmacies / Santé / Alimentation)
    shown = [a for a in candidates if category in ("all", "") or a["category"] == category]
    reachable = [a for a in shown if a["reachable"]]
    # Masque « désert » : le monde entier MOINS la zone atteignable.
    # Sur la carte, tout ce qui est hors de portée est ainsi grisé.
    mask = box(-180, -85, 180, 85).difference(area.polygon)

    return {
        "osm_status": osm_status,
        "streets_status": streets_status,
        "method": area.method,
        "origin": {"lat": lat, "lon": lon},
        "stats": {
            "walk_minutes": minutes,
            "walk_radius_m": round(radius),
            "reachable_total": len(reachable),
            "pharmacies": sum(1 for a in reachable if a["category"] == "pharmacy"),
            "healthcare": sum(1 for a in reachable if a["category"] == "healthcare"),
            "food": sum(1 for a in reachable if a["category"] == "food"),
            "categories_reachable": sum(1 for value in nearest.values() if value),
        },
        "nearest": nearest,
        "reachable_area": {"type": "Feature", "geometry": mapping(area.polygon), "properties": {}},
        "desert_mask": {"type": "Feature", "geometry": mapping(mask), "properties": {}},
        "amenities": {
            "type": "FeatureCollection",
            "features": [amenity_feature(a, walk_minutes=a["walk_minutes"], reachable=a["reachable"]) for a in shown],
        },
    }


# ==============================================================================
# MODE « TOUTE LA ZONE » : combien de temps pour aller jusqu'à un lieu
# ==============================================================================


# Appelé quand l'utilisateur clique sur un lieu : combien de temps pour y aller ?
@app.get("/api/trip")
def trip(
    from_lat: float = Query(..., description="Latitude de départ (ma position)"),
    from_lon: float = Query(..., description="Longitude de départ"),
    to_lat: float = Query(..., description="Latitude d'arrivée (le lieu choisi)"),
    to_lon: float = Query(..., description="Longitude d'arrivée"),
) -> dict:
    """
    6. Temps de trajet vers un lieu :
       - à pied, à vélo, à moto et en voiture, le long des vraies routes (OSRM / OpenStreetMap)
       - les itinéraires en bus / tram recommandés, du plus rapide au plus lent (hors attente)
    """
    return {
        "trips": trip_times(from_lat, from_lon, to_lat, to_lon),
        "transit": transit_options(from_lat, from_lon, to_lat, to_lon),
    }


# Couche « Bus et tram » : affichée seulement si l'interrupteur est activé
@app.get("/api/transit")
def transit(
    min_lat: float = Query(..., description="Latitude sud"),
    min_lon: float = Query(..., description="Longitude ouest"),
    max_lat: float = Query(..., description="Latitude nord"),
    max_lon: float = Query(..., description="Longitude est"),
    zoom: int = Query(14, description="Niveau de zoom actuel"),
) -> dict:
    """7. Couche « Bus et tram » : voies de tram et arrêts de la zone visible (arrêts de bus dès le zoom 15)."""
    if zoom < 12:
        return {"status": "zoom_in", "stops": [], "tram_lines": []}
    return transit_layer(min_lat, min_lon, max_lat, max_lon, with_bus_stops=zoom >= 15)


# ==============================================================================
# ANALYSE H3 : population et accès aux services, hexagone par hexagone
# ==============================================================================

# Marge autour de la vue : un service juste hors écran peut être le plus proche
# Voir services/analysis.py (calcul) et services/population.py (données d'habitants)
ANALYSIS_PADDING_M = 1500


# Couche « Population (H3) » : découpe la vue en hexagones et calcule, pour chacun,
# le temps de marche vers les services et le nombre d'habitants.
@app.get("/api/analysis")
def analysis(
    min_lat: float = Query(..., description="Latitude sud"),
    min_lon: float = Query(..., description="Longitude ouest"),
    max_lat: float = Query(..., description="Latitude nord"),
    max_lon: float = Query(..., description="Longitude est"),
    zoom: int = Query(14, description="Niveau de zoom actuel"),
    minutes: int = Query(15, ge=5, le=30, description="Seuil de temps de marche (minutes)"),
    # Depends(require_pro) : FastAPI vérifie le jeton AVANT d'exécuter la fonction ;
    # sans compte pro, la requête est refusée (401 ou 403)
    user: dict = Depends(require_pro),
) -> dict:
    """
    8. Analyse de la vue en hexagones H3 (~350 m) :
       - temps de marche vers la pharmacie, la santé et l'alimentation les plus proches
       - population de chaque hexagone (Kontur Population)
       - habitants à plus de `minutes` d'un service et zones prioritaires
    """
    if zoom < 13:
        return {"status": "zoom_in", "osm_status": "zoom_in", "population_status": "zoom_in"}
    # 1. Les services (vue + marge), téléchargés si besoin
    padded = pad_bbox(min_lat, min_lon, max_lat, max_lon, ANALYSIS_PADDING_M)
    osm_status = ensure_osm_data(*padded, zoom=zoom)
    amenities = get_amenities_in_bbox(*padded)
    # 2. La population du pays au centre de la vue (téléchargée une seule fois)
    population_status, population = population_for((min_lat + max_lat) / 2, (min_lon + max_lon) / 2)
    # 3. Le calcul hexagone par hexagone
    result = analyze_area(min_lat, min_lon, max_lat, max_lon, amenities, minutes, population)
    return {
        **result,
        "osm_status": osm_status,
        "population_status": population_status,
        "population_source": "Kontur Population (CC BY 4.0)" if population else None,
    }


# Permet de lancer le serveur directement avec « python -m app.main » (mode développement :
# reload=True redémarre le serveur à chaque modification du code).
# ==============================================================================
# COMPTES : citoyen (facultatif) et pro (pharmacie, supermarché, clinique... : outils d'analyse)
# ==============================================================================


class RegisterBody(BaseModel):
    """Données envoyées par le formulaire d'inscription (vérifiées automatiquement par FastAPI)."""

    email: str = Field(..., max_length=120)
    password: str = Field(..., min_length=8, max_length=128)
    role: Literal["citizen", "pro"] = "citizen"
    display_name: str = Field("", max_length=80)  # nom de l'établissement (pro) ou prénom (citoyen)


class LoginBody(BaseModel):
    email: str = Field(..., max_length=120)
    password: str = Field(..., max_length=128)


@app.post("/api/auth/register")
def auth_register(body: RegisterBody) -> dict:
    """9. Création d'un compte : renvoie un jeton de connexion et les informations du compte."""
    return register(body.email, body.password, body.role, body.display_name)


@app.post("/api/auth/login")
def auth_login(body: LoginBody) -> dict:
    """10. Connexion avec email + mot de passe."""
    return login(body.email, body.password)


@app.get("/api/auth/me")
def auth_me(user: dict | None = Depends(current_user)) -> dict:
    """11. Compte connecté (null si le jeton est absent ou expiré)."""
    return {"user": user}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
