# ==============================================================================
# location.py : deux services de localisation.
#   - detect_location_by_ip : pays/ville approximatifs à partir de l'adresse IP
#     (service gratuit ipwho.is), pour centrer la carte à la première visite.
#   - search_places : la barre de recherche (service Nominatim d'OpenStreetMap).
# ==============================================================================
import ipaddress
import logging

import requests

logger = logging.getLogger("caremap-location")

# Identification envoyée aux services externes
HEADERS = {"User-Agent": "CareMap/1.0 (projet étudiant, carte d'accès aux soins)"}


# Vrai si l'adresse IP est publique (Internet), faux si privée (Docker, 127.0.0.1, 192.168...)
def _is_public(ip: str | None) -> bool:
    try:
        return bool(ip) and ipaddress.ip_address(ip).is_global
    except ValueError:
        return False


def detect_location_by_ip(client_ip: str | None = None) -> dict:
    """
    Detects the user's approximate country, city, and coordinates via IP address.
    Does not require any browser location permission.

    Sur un serveur public, on interroge l'IP du visiteur (sinon ce serait celle du serveur).
    En local, l'IP vue est privée (Docker, 127.0.0.1) : ipwho.is prend alors l'IP de sortie,
    qui est celle de la connexion de l'utilisateur.
    """
    # Avec une IP publique on demande cette IP précise, sinon ipwho.is utilise l'IP qui l'appelle
    url = f"https://ipwho.is/{client_ip}" if _is_public(client_ip) else "https://ipwho.is/"
    try:
        resp = requests.get(url, headers=HEADERS, timeout=3)
        if resp.status_code == 200:
            data = resp.json()
            if data.get("success", False):
                return {
                    "method": "ip",
                    "country": data.get("country", "France"),
                    "city": data.get("city", "Paris"),
                    "latitude": data.get("latitude", 48.8566),
                    "longitude": data.get("longitude", 2.3522),
                }
    except Exception as e:
        logger.warning(f"IP Geolocation error ({e}). Using default coordinates.")

    # Valeurs de secours (Paris) si le service est injoignable : la carte s'ouvre quand même
    return {
        "method": "fallback",
        "country": "France",
        "city": "Paris",
        "latitude": 48.8566,
        "longitude": 2.3522,
    }


def search_places(query: str, limit: int = 5) -> list[dict]:
    """Recherche une ville, un quartier ou une adresse via Nominatim (OpenStreetMap)."""
    # Nominatim transforme un texte (« Salé », « Avenue Hassan II ») en coordonnées
    try:
        resp = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": query, "format": "jsonv2", "limit": limit, "accept-language": "fr"},
            headers=HEADERS,
            timeout=6,
        )
        resp.raise_for_status()
    except Exception as e:
        logger.warning(f"Nominatim search error ({e}).")
        return []

    # On garde seulement les informations utiles au frontend pour chaque résultat
    return [
        {
            "label": place.get("display_name", ""),
            "name": place.get("name") or place.get("display_name", "").split(",")[0],
            "type": place.get("addresstype") or place.get("type", ""),
            "latitude": float(place["lat"]),
            "longitude": float(place["lon"]),
        }
        for place in resp.json()
    ]
