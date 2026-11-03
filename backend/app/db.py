# ==============================================================================
# db.py : la base de données SQLite (fichier backend/data/caremap.db).
#
# Elle sert de CACHE : les lieux téléchargés depuis OpenStreetMap y sont gardés
# pour ne pas redemander Internet à chaque déplacement de la carte.
#
# Deux tables :
#   amenities     -> les lieux (nom, catégorie, adresse, latitude, longitude, horaires)
#   fetched_cells -> les carrés de carte (« cellules » de ~2 km) déjà téléchargés
# ==============================================================================
import logging
import math
import sqlite3
from pathlib import Path

logger = logging.getLogger("caremap-db")

# Chemins des fichiers : __file__ = ce fichier (backend/app/db.py)
BASE_DIR = Path(__file__).resolve().parent.parent  # backend/
DATA_DIR = BASE_DIR / "data"
# Crée le dossier data/ s'il n'existe pas encore
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "caremap.db"

# Ancien nom du projet (« urbanwalk ») : on reprend la base existante pour garder le cache
_LEGACY_DB_PATH = DATA_DIR / "walkability.db"
if _LEGACY_DB_PATH.exists() and not DB_PATH.exists():
    _LEGACY_DB_PATH.rename(DB_PATH)

# Données d'amorce par défaut (Paris Bastille / 11e) pour démarrer sans dépendre de fichiers externes
INITIAL_SEED_AMENITIES = [
    ("Pharmacie de la Bastille", "pharmacy", "Pharmacie", "4 Bd Richard-Lenoir, Paris", 48.8542, 2.3705),
    ("Pharmacie Roquette Popincourt", "pharmacy", "Pharmacie", "45 Rue de la Roquette, Paris", 48.8551, 2.3742),
    ("Pharmacie Breguet Sabin", "pharmacy", "Pharmacie", "18 Rue Saint-Sabin, Paris", 48.8560, 2.3680),
    ("Pharmacie Ledru-Rollin", "pharmacy", "Pharmacie", "88 Avenue Ledru-Rollin, Paris", 48.8510, 2.3765),
    (
        "Centre Médical Saint-Antoine",
        "healthcare",
        "Santé & Clinique",
        "184 Rue du Faubourg Saint-Antoine",
        48.8502,
        2.3815,
    ),
    ("Cabinet Médical Bastille-Marais", "healthcare", "Santé & Clinique", "12 Rue Amelot, Paris", 48.8555, 2.3670),
    ("Maison de Santé Roquette", "healthcare", "Santé & Clinique", "80 Rue de la Roquette, Paris", 48.8565, 2.3790),
    (
        "Marché d’Aligre (Frais & Primeurs)",
        "food",
        "Alimentation Essentielle",
        "Place d’Aligre, Paris",
        48.8492,
        2.3775,
    ),
    (
        "Boulangerie Terroirs & Levain",
        "food",
        "Alimentation Essentielle",
        "34 Rue de la Roquette, Paris",
        48.8546,
        2.3735,
    ),
    ("Biocoop Bastille", "food", "Alimentation Essentielle", "58 Rue du Faubourg Saint-Antoine", 48.8518, 2.3740),
    (
        "Supermarché Monoprix Bastille",
        "food",
        "Alimentation Essentielle",
        "10 Rue de la Roquette, Paris",
        48.8538,
        2.3700,
    ),
    ("Carrefour Express Ledru-Rollin", "food", "Alimentation Essentielle", "112 Avenue Ledru-Rollin", 48.8522, 2.3770),
]


# Taille d'une cellule de la grille de téléchargement OSM (≈ 2 km)
CELL_SIZE_DEG = 0.02


# Chaque fonction ouvre sa propre connexion avec « with get_db_connection() as conn: »
def get_db_connection() -> sqlite3.Connection:
    """Ouvre une connexion à SQLite avec accès aux colonnes par leur nom."""
    conn = sqlite3.connect(DB_PATH)
    # row_factory = Row : on peut écrire row["name"] au lieu de row[1]
    conn.row_factory = sqlite3.Row
    return conn


# Appelée une fois au démarrage du serveur (voir lifespan dans main.py)
def init_db() -> None:
    """Initialise la table des commodités et crée un index spatial de base."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Table des lieux. UNIQUE(...) empêche d'enregistrer deux fois le même lieu.
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS amenities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                category TEXT NOT NULL,
                category_label TEXT NOT NULL,
                address TEXT,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                UNIQUE(name, latitude, longitude)
            );
        """)
        # Index sur les coordonnées : rend la recherche « lieux dans ce rectangle » beaucoup plus rapide
        cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_amenities_coords
            ON amenities(latitude, longitude);
        """)
        # Cellules de grille déjà téléchargées depuis OpenStreetMap
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS fetched_cells (
                cell TEXT PRIMARY KEY,
                fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()

        # Migration : horaires d'ouverture (tag OSM « opening_hours »).
        # Les zones déjà en cache n'en ont pas : on les oublie une fois pour qu'elles
        # soient retéléchargées (les lieux existants sont mis à jour, pas dupliqués).
        # PRAGMA table_info = liste des colonnes existantes de la table
        columns = {row["name"] for row in cursor.execute("PRAGMA table_info(amenities);")}
        if "opening_hours" not in columns:
            cursor.execute("ALTER TABLE amenities ADD COLUMN opening_hours TEXT DEFAULT '';")
            cursor.execute("DELETE FROM fetched_cells;")
            conn.commit()
            logger.info("Horaires d'ouverture ajoutés : les zones seront retéléchargées depuis OSM.")

        # Si la base est neuve, insérer les points de départ
        cursor.execute("SELECT COUNT(*) AS total FROM amenities;")
        if cursor.fetchone()["total"] == 0:
            cursor.executemany(
                """
                INSERT OR IGNORE INTO amenities (name, category, category_label, address, latitude, longitude)
                VALUES (?, ?, ?, ?, ?, ?);
            """,
                INITIAL_SEED_AMENITIES,
            )
            conn.commit()
            logger.info("Base SQLite initialisée avec les commodités de départ.")


# bbox (« bounding box ») = rectangle défini par latitude/longitude min et max
def get_amenities_in_bbox(
    min_lat: float, min_lon: float, max_lat: float, max_lon: float, category: str = "all"
) -> list[dict]:
    """Récupère les commodités visibles dans la zone géographique actuelle."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Les « ? » sont remplacés par les valeurs du tuple : c'est plus sûr que de
        # coller les valeurs dans le texte SQL (protège contre l'injection SQL).
        if category == "all" or not category:
            cursor.execute(
                """
                SELECT * FROM amenities
                WHERE latitude BETWEEN ? AND ?
                  AND longitude BETWEEN ? AND ?;
            """,
                (min_lat, max_lat, min_lon, max_lon),
            )
        else:
            cursor.execute(
                """
                SELECT * FROM amenities
                WHERE latitude BETWEEN ? AND ?
                  AND longitude BETWEEN ? AND ?
                  AND category = ?;
            """,
                (min_lat, max_lat, min_lon, max_lon, category),
            )
        rows = cursor.fetchall()

    # Conversion en dictionnaires Python simples (plus faciles à manipuler et à renvoyer en JSON)
    return [dict(row) for row in rows]


def save_amenities(items: list[dict]) -> int:
    """Sauvegarde de nouvelles commodités récupérées à la volée dans SQLite."""
    if not items:
        return 0
    # Préparation des lignes à insérer (valeurs par défaut si une information manque)
    records = []
    for item in items:
        records.append(
            (
                item.get("name", "Sans nom"),
                item.get("category", "other"),
                item.get("category_label", "Commodité"),
                item.get("address", ""),
                float(item["latitude"]),
                float(item["longitude"]),
                item.get("opening_hours", ""),
            )
        )

    with get_db_connection() as conn:
        cursor = conn.cursor()
        # Si le lieu existe déjà : pas de doublon, on met seulement à jour ses horaires
        cursor.executemany(
            """
            INSERT INTO amenities (name, category, category_label, address, latitude, longitude, opening_hours)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name, latitude, longitude) DO UPDATE SET opening_hours = excluded.opening_hours;
        """,
            records,
        )
        conn.commit()
        return cursor.rowcount


# Grille fixe : chaque cellule est identifiée par (numéro de ligne, numéro de colonne).
# Exemple : latitude 34.02 / 0.02 = cellule n° 1701 en latitude.
def cells_for_bbox(min_lat: float, min_lon: float, max_lat: float, max_lon: float) -> list[tuple[int, int]]:
    """Liste les cellules de grille (lat_idx, lon_idx) qui recouvrent la zone."""
    lat_range = range(math.floor(min_lat / CELL_SIZE_DEG), math.floor(max_lat / CELL_SIZE_DEG) + 1)
    lon_range = range(math.floor(min_lon / CELL_SIZE_DEG), math.floor(max_lon / CELL_SIZE_DEG) + 1)
    return [(i, j) for i in lat_range for j in lon_range]


def get_missing_cells(cells: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Renvoie les cellules qui n'ont jamais été téléchargées depuis OSM."""
    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("SELECT cell FROM fetched_cells;")
        known = {row["cell"] for row in cursor.fetchall()}
    # Les cellules sont stockées en texte « ligne:colonne », ex. « 1701:-342 »
    return [cell for cell in cells if f"{cell[0]}:{cell[1]}" not in known]


def mark_cells_fetched(cells: list[tuple[int, int]]) -> None:
    """Mémorise les cellules téléchargées pour ne pas réinterroger OSM."""
    with get_db_connection() as conn:
        conn.executemany(
            "INSERT OR IGNORE INTO fetched_cells (cell) VALUES (?);",
            [(f"{i}:{j}",) for i, j in cells],
        )
        conn.commit()


# Inverse de cells_for_bbox : le rectangle qui contient toutes les cellules données
def bbox_of_cells(cells: list[tuple[int, int]]) -> tuple[float, float, float, float]:
    """Bbox (min_lat, min_lon, max_lat, max_lon) englobant une liste de cellules."""
    lats = [i for i, _ in cells]
    lons = [j for _, j in cells]
    return (
        min(lats) * CELL_SIZE_DEG,
        min(lons) * CELL_SIZE_DEG,
        (max(lats) + 1) * CELL_SIZE_DEG,
        (max(lons) + 1) * CELL_SIZE_DEG,
    )
