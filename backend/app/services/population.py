"""
Population par hexagone H3 : jeu de données Kontur Population (licence CC BY 4.0).

Kontur publie, pour chaque pays, la population estimée de chaque hexagone H3
d'environ 400 m (résolution 8), sur HDX (Humanitarian Data Exchange) :
https://data.humdata.org/organization/kontur

1. Le pays de la zone est trouvé avec Nominatim (géocodage inverse).
2. L'adresse du fichier du pays est trouvée avec l'API de HDX (le nom du fichier
   change à chaque mise à jour, il n'est donc jamais écrit en dur).
3. Le fichier (GeoPackage compressé) est téléchargé une seule fois en arrière-plan,
   puis réduit à un simple dictionnaire { hexagone H3 : population } sur disque.
"""

import gzip
import json
import logging
import re
import shutil
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
from pathlib import Path

import h3
import requests

from app.db import DATA_DIR

logger = logging.getLogger("caremap-population")

# Dossier du cache : backend/data/population/MA.json.gz pour le Maroc, FR.json.gz pour la France...
POP_DIR = DATA_DIR / "population"
POP_DIR.mkdir(parents=True, exist_ok=True)

# Adresses des services externes : HDX (catalogue des données) et Nominatim (trouver le pays)
HDX_API = "https://data.humdata.org/api/3/action"
NOMINATIM_REVERSE = "https://nominatim.openstreetmap.org/reverse"
HEADERS = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}
# Après un échec, on attend 5 minutes avant de réessayer
RETRY_AFTER_SECONDS = 300

# Téléchargement en arrière-plan (un seul à la fois : les fichiers pays sont gros)
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="population")
_lock = threading.Lock()
# Pays en cours de téléchargement
_in_progress: set[str] = set()
# Pays -> moment du dernier échec
_failed_at: dict[str, float] = {}
# Pays déjà chargés en mémoire (évite de relire le fichier à chaque requête)
_loaded: dict[str, dict] = {}


# --- Pays de la zone ------------------------------------------------------------


# lru_cache garde la réponse en mémoire : une seule requête Nominatim par zone de ~10 km
@lru_cache(maxsize=256)
def _country_at(lat_r: float, lon_r: float) -> tuple[str, str] | None:
    """(code ISO2, nom anglais) du pays à cet endroit, via Nominatim."""
    try:
        resp = requests.get(
            NOMINATIM_REVERSE,
            # zoom=3 = niveau « pays » ; accept-language=en car les jeux de données HDX sont nommés en anglais
            params={"lat": lat_r, "lon": lon_r, "format": "json", "zoom": 3, "accept-language": "en"},
            headers=HEADERS,
            timeout=8,
        )
        resp.raise_for_status()
        address = resp.json().get("address", {})
        code, name = address.get("country_code"), address.get("country")
        return (code.upper(), name) if code and name else None
    except Exception as e:
        logger.warning(f"Pays introuvable pour ({lat_r}, {lon_r}) : {e}")
        return None


def country_for(lat: float, lon: float) -> tuple[str, str] | None:
    # Arrondi à 0,1° (~10 km) : une seule requête par zone, résultat gardé en mémoire
    return _country_at(round(lat, 1), round(lon, 1))


# --- Téléchargement depuis HDX --------------------------------------------------


# Appel générique à l'API de HDX ; renvoie None en cas de problème
def _hdx(action: str, **params) -> dict | None:
    try:
        resp = requests.get(f"{HDX_API}/{action}", params=params, headers=HEADERS, timeout=20)
        if resp.status_code != 200:
            return None
        payload = resp.json()
        return payload.get("result") if payload.get("success") else None
    except Exception as e:
        logger.warning(f"HDX {action} indisponible : {e}")
        return None


# Cherche, parmi les fichiers d'un jeu de données, celui au format GeoPackage (.gpkg / .gpkg.gz)
def _gpkg_url(package: dict) -> str | None:
    for resource in package.get("resources", []):
        url = resource.get("url") or ""
        if url.endswith((".gpkg.gz", ".gpkg")):
            return url
    return None


def find_dataset_url(country_name: str) -> str | None:
    """Adresse du fichier Kontur Population (400 m) du pays, via l'API de HDX."""
    # 1er essai : le nom habituel, ex. « Morocco » -> « kontur-population-morocco »
    slug = re.sub(r"[^a-z0-9]+", "-", country_name.lower()).strip("-")
    package = _hdx("package_show", id=f"kontur-population-{slug}")
    if package and (url := _gpkg_url(package)):
        return url
    # Nom de pays écrit autrement (« Côte d'Ivoire »…) : recherche dans l'organisation Kontur
    found = _hdx("package_search", q=f"population {country_name}", fq="organization:kontur", rows=20)
    for candidate in (found or {}).get("results", []):
        name = candidate.get("name", "")
        if name.startswith("kontur-population-") and "dataset" not in name:
            if url := _gpkg_url(candidate):
                return url
    return None


def _read_population(gpkg_path: Path) -> tuple[dict[str, float], int]:
    """GeoPackage Kontur → { hexagone H3 : population } et résolution H3 des hexagones."""
    import geopandas as gpd  # imports locaux : seulement au téléchargement
    import pyogrio

    # Lecture des seuls attributs (sans les formes) : plus rapide et plus léger en mémoire
    table = pyogrio.read_dataframe(gpkg_path, read_geometry=False)
    # Recherche de la colonne qui contient les identifiants H3 (normalement « h3 »)
    h3_col = "h3" if "h3" in table.columns else None
    if h3_col is None:
        for col in table.columns:
            sample = table[col].dropna().astype(str).head(5)
            if len(sample) and all(h3.is_valid_cell(v) for v in sample):
                h3_col = col
                break
    # Recherche de la colonne de population (normalement « population »)
    pop_col = "population" if "population" in table.columns else None
    if pop_col is None:
        numeric = table.select_dtypes("number").columns
        pop_col = numeric[0] if len(numeric) else None

    if h3_col and pop_col:
        # Cas normal : dictionnaire { identifiant H3 : population }
        cells = dict(zip(table[h3_col].astype(str), table[pop_col].astype(float), strict=True))
    else:
        # Pas de colonne H3 : on la recalcule depuis le centre de chaque hexagone
        shapes = gpd.read_file(gpkg_path, engine="pyogrio")
        pop_col = pop_col or shapes.select_dtypes("number").columns[0]
        # Centres calculés en mètres (EPSG:3857), puis convertis en latitude/longitude
        centers = shapes.to_crs(3857).geometry.centroid.to_crs(4326)
        cells = {h3.latlng_to_cell(pt.y, pt.x, 8): float(pop) for pt, pop in zip(centers, shapes[pop_col], strict=True)}
    # Résolution des hexagones du fichier (8 pour Kontur)
    resolution = h3.get_resolution(next(iter(cells))) if cells else 8
    return cells, resolution


# Exécuté en arrière-plan : trouve le fichier du pays, le télécharge, le lit, puis
# l'enregistre dans un petit fichier compressé (data/population/<CODE>.json.gz).
def _download(code: str, name: str) -> None:
    try:
        url = find_dataset_url(name)
        if not url:
            logger.warning(f"Population : aucun jeu Kontur trouvé pour {name}.")
            with _lock:
                _failed_at[code] = time.monotonic()
            return
        logger.info(f"Population : téléchargement de {url}")
        # Dossier temporaire : supprimé automatiquement à la fin (le gros fichier ne reste pas sur le disque)
        with tempfile.TemporaryDirectory() as tmp:
            raw = Path(tmp) / "population.download"
            with requests.get(url, headers=HEADERS, timeout=300, stream=True) as resp:
                resp.raise_for_status()
                with open(raw, "wb") as out:
                    shutil.copyfileobj(resp.raw, out)
            gpkg = Path(tmp) / "population.gpkg"
            # Le fichier est compressé (.gz) : on le décompresse avant de le lire
            if url.endswith(".gz"):
                with gzip.open(raw, "rb") as src, open(gpkg, "wb") as dst:
                    shutil.copyfileobj(src, dst)
            else:
                raw.rename(gpkg)
            cells, resolution = _read_population(gpkg)
        # Version réduite et rapide à relire : seulement les hexagones et leur population
        data = {"country": name, "source": url, "resolution": resolution, "cells": cells}
        with gzip.open(POP_DIR / f"{code}.json.gz", "wt", encoding="utf-8") as f:
            json.dump(data, f)
        _loaded[code] = data
        logger.info(f"Population : {len(cells)} hexagones chargés pour {name} (résolution {resolution}).")
    except Exception as e:
        logger.warning(f"Population : échec pour {name} ({e}).")
        with _lock:
            _failed_at[code] = time.monotonic()
    finally:
        with _lock:
            _in_progress.discard(code)


# Lit les données d'un pays : d'abord en mémoire, sinon depuis le fichier cache
def _load(code: str) -> dict | None:
    if code in _loaded:
        return _loaded[code]
    path = POP_DIR / f"{code}.json.gz"
    if not path.exists():
        return None
    with gzip.open(path, "rt", encoding="utf-8") as f:
        _loaded[code] = json.load(f)
    return _loaded[code]


def population_for(lat: float, lon: float) -> tuple[str, dict | None]:
    """
    État et données de population pour la zone.
    État : "ready", "loading" (téléchargement en cours), "unavailable" ou "unknown_country".
    """
    # 1. Quel pays ? 2. Déjà en cache ? 3. Sinon : téléchargement en arrière-plan (état « loading »)
    country = country_for(lat, lon)
    if not country:
        return "unknown_country", None
    code, name = country
    data = _load(code)
    if data:
        return "ready", data
    with _lock:
        if code in _in_progress:
            return "loading", None
        if time.monotonic() - _failed_at.get(code, -RETRY_AFTER_SECONDS) < RETRY_AFTER_SECONDS:
            return "unavailable", None
        _in_progress.add(code)
    _executor.submit(_download, code, name)
    return "loading", None
