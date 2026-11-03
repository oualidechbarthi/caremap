# Image Docker du backend : Python 3.12 léger + nos dépendances + le code de l'API
FROM python:3.12-slim

# Variables : pas de fichiers .pyc, logs affichés immédiatement, pas de cache pip (image plus légère)
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

# Dependencies first, so this layer is cached between code changes
COPY requirements.txt .
# Délai et nouvelles tentatives plus longs : évite l'échec du build sur une connexion lente
RUN pip install --default-timeout=120 --retries 10 -r requirements.txt

# Copie du code du backend
COPY app ./app
COPY scripts ./scripts

# SQLite cache (backend/data/caremap.db) - mounted from the host in docker-compose
RUN mkdir -p /app/data

# L'API écoute sur le port 8000 du conteneur
EXPOSE 8000

# Toutes les 15 s, Docker vérifie que l'API répond (le conteneur devient « healthy »)
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=4)" || exit 1

# Commande de démarrage : uvicorn lance l'application FastAPI (app/main.py, variable app)
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
