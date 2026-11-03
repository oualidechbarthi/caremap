#!/usr/bin/env python3
"""
Script d'initialisation de la base SQLite pour le projet CareMap.
Initialise la table des commodités pour le cache local d'exploration à la volée.

Usage :
    python backend/scripts/init_db.py
"""

from app.db import DB_PATH, get_db_connection, init_db

print("Initialisation de la base SQLite...")
# Crée les tables si elles n'existent pas (même fonction que celle appelée au démarrage de l'API)
init_db()

# Compte les lieux déjà présents dans le cache pour l'afficher
with get_db_connection() as conn:
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) AS total FROM amenities;")
    amenities_count = cursor.fetchone()["total"]

print(f"✔ Base SQLite prête : {DB_PATH}")
print(f"  - {amenities_count} commodités en cache local")
print("  - Les déserts et bassins piétons sont calculés EN DIRECT à la volée lors de la navigation !")
