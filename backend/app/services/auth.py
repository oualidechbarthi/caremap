"""
Comptes utilisateurs : inscription, connexion et rôles.

Deux types de comptes :
  - "citizen" (citoyen) : facultatif, l'application reste utilisable sans compte ;
  - "pro" (professionnel : pharmacie, supermarché, clinique, hôpital...) : donne accès aux outils d'analyse
    (population par hexagones H3, zones prioritaires).

Sécurité, uniquement avec la bibliothèque standard de Python (aucune dépendance en plus) :
  - les mots de passe ne sont JAMAIS enregistrés en clair : on garde une empreinte
    PBKDF2-SHA256 avec un « sel » aléatoire propre à chaque compte ;
  - après connexion, le navigateur reçoit un « jeton » signé (HMAC-SHA256) valable 30 jours,
    qu'il renvoie dans l'en-tête « Authorization: Bearer <jeton> ».

Confidentialité : la table des comptes ne contient AUCUNE position ni historique de trajets.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import time
from functools import lru_cache

from fastapi import Depends, Header, HTTPException

from app.db import DATA_DIR, get_db_connection

# Clé secrète qui signe les jetons (fichier créé automatiquement au premier démarrage)
SECRET_PATH = DATA_DIR / "secret.key"
# Durée de validité d'une connexion
TOKEN_DAYS = 30
# Nombre de tours de PBKDF2 : rend le « devinage » de mots de passe très lent pour un attaquant
PBKDF2_ROUNDS = 200_000
ROLES = ("citizen", "pro")
# Vérification simple du format d'un email (quelque chose@domaine.extension)
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --- Table des comptes ------------------------------------------------------------


def init_users_table() -> None:
    """Crée la table des comptes si elle n'existe pas (appelée au démarrage du serveur)."""
    with get_db_connection() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL,
                display_name TEXT DEFAULT '',
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
        """)
        conn.commit()


def public_user(row) -> dict:
    """Informations d'un compte que l'on peut renvoyer au navigateur (jamais l'empreinte du mot de passe)."""
    return {"id": row["id"], "email": row["email"], "role": row["role"], "display_name": row["display_name"]}


# --- Mots de passe ------------------------------------------------------------------


def hash_password(password: str) -> str:
    """Empreinte du mot de passe, au format « pbkdf2_sha256$tours$sel$empreinte »."""
    salt = secrets.token_bytes(16)  # sel aléatoire : deux mots de passe identiques donnent deux empreintes différentes
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Recalcule l'empreinte avec le même sel et la compare à celle enregistrée."""
    try:
        _, rounds, salt_hex, digest_hex = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds))
    except ValueError:
        return False
    # compare_digest : comparaison en temps constant (ne révèle rien par le temps de réponse)
    return hmac.compare_digest(digest.hex(), digest_hex)


# --- Jetons de connexion --------------------------------------------------------------


@lru_cache(maxsize=1)
def _secret() -> bytes:
    """Clé de signature : variable d'environnement CAREMAP_SECRET, sinon fichier data/secret.key."""
    from_env = os.environ.get("CAREMAP_SECRET")
    if from_env:
        return from_env.encode()
    if not SECRET_PATH.exists():
        SECRET_PATH.write_text(secrets.token_hex(32))
    return SECRET_PATH.read_text().strip().encode()


def _b64(data: bytes) -> str:
    # Base64 « URL » sans les « = » de fin : le jeton reste un simple texte
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def create_token(user_id: int, role: str) -> str:
    """Jeton « contenu.signature » : le contenu dit qui est connecté, la signature prouve qu'il vient du serveur."""
    payload = {"uid": user_id, "role": role, "exp": int(time.time()) + TOKEN_DAYS * 86400}
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    signature = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
    return f"{body}.{signature}"


def read_token(token: str) -> dict | None:
    """Contenu du jeton s'il est authentique et pas expiré, sinon None."""
    try:
        body, signature = token.split(".")
        expected = _b64(hmac.new(_secret(), body.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None  # jeton modifié ou fabriqué : refusé
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    return payload if payload.get("exp", 0) > time.time() else None


# --- Inscription et connexion -----------------------------------------------------------


def register(email: str, password: str, role: str, display_name: str) -> dict:
    """Crée un compte et renvoie { token, user }. Erreurs : 400 (données invalides) ou 409 (email déjà utilisé)."""
    email = email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Adresse email invalide.")
    if len(password) < 8:
        raise HTTPException(400, "Le mot de passe doit contenir au moins 8 caractères.")
    if role not in ROLES:
        raise HTTPException(400, "Type de compte inconnu.")
    with get_db_connection() as conn:
        if conn.execute("SELECT 1 FROM users WHERE email = ?;", (email,)).fetchone():
            raise HTTPException(409, "Un compte existe déjà avec cet email.")
        cursor = conn.execute(
            "INSERT INTO users (email, password_hash, role, display_name) VALUES (?, ?, ?, ?);",
            (email, hash_password(password), role, display_name.strip()),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM users WHERE id = ?;", (cursor.lastrowid,)).fetchone()
    return {"token": create_token(row["id"], row["role"]), "user": public_user(row)}


def login(email: str, password: str) -> dict:
    """Vérifie email + mot de passe et renvoie { token, user }. Erreur 401 sinon."""
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE email = ?;", (email.strip().lower(),)).fetchone()
    # Même message que l'email existe ou non : on ne révèle pas quels emails ont un compte
    if row is None or not verify_password(password, row["password_hash"]):
        raise HTTPException(401, "Email ou mot de passe incorrect.")
    return {"token": create_token(row["id"], row["role"]), "user": public_user(row)}


# --- « Dépendances » FastAPI : qui fait la requête ? --------------------------------------


def current_user(authorization: str | None = Header(None)) -> dict | None:
    """Compte connecté d'après l'en-tête Authorization, ou None (visiteur sans compte)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    payload = read_token(authorization.removeprefix("Bearer "))
    if payload is None:
        return None
    with get_db_connection() as conn:
        row = conn.execute("SELECT * FROM users WHERE id = ?;", (payload["uid"],)).fetchone()
    return public_user(row) if row else None


def require_user(user: dict | None = Depends(current_user)) -> dict:
    """Pour les adresses réservées aux comptes connectés (erreur 401 sinon)."""
    if user is None:
        raise HTTPException(401, "Connexion requise.")
    return user


def require_pro(user: dict = Depends(require_user)) -> dict:
    """Pour les outils réservés aux professionnels (erreur 403 pour un compte citoyen)."""
    if user["role"] != "pro":
        raise HTTPException(403, "Réservé aux comptes pro.")
    return user
