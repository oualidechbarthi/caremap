#!/usr/bin/env bash
# ==============================================================================
# Script d'installation simplifié : CareMap — Accès aux soins et aux services essentiels
# ==============================================================================

set -e

# Couleurs pour le terminal
GREEN="\033[0;32m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RESET="\033[0m"

echo -e "${CYAN}==================================================================${RESET}"
echo -e "${CYAN}         CareMap — Guide d'Installation pour Contributeurs        ${RESET}"
echo -e "${CYAN}==================================================================${RESET}"

# 1. Vérification des outils nécessaires
echo -e "\n${YELLOW}[1/4] Vérification des prérequis...${RESET}"
command -v python3 >/dev/null 2>&1 || { echo "Python 3 est requis mais non installé."; exit 1; }
command -v node >/dev/null 2>&1 || { echo "Node.js est requis mais non installé."; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm est requis mais non installé."; exit 1; }
echo -e "  ✔ Python3, Node.js et npm sont bien présents."

# 2. Installation Backend
echo -e "\n${YELLOW}[2/4] Préparation du Backend Python & Ruff...${RESET}"
if [ ! -d "backend/venv" ]; then
    echo "  ⚙ Création de l'environnement virtuel backend/venv..."
    python3 -m venv backend/venv
fi

echo "  ⚙ Installation des dépendances minimales et de Ruff..."
./backend/venv/bin/pip install --upgrade pip --quiet
./backend/venv/bin/pip install -r backend/requirements.txt --quiet || ./backend/venv/bin/pip install fastapi uvicorn[standard] geojson requests ruff --quiet
echo -e "  ✔ Backend et Ruff prêts !"

# 3. Initialisation et peuplement de la base de données SQLite
echo -e "\n${YELLOW}[3/4] Initialisation de la base SQLite locale...${RESET}"
PYTHONPATH=backend ./backend/venv/bin/python backend/scripts/init_db.py
echo -e "  ✔ Base SQLite initialisée et ignorée par git (fichier non versionné) !"

# 4. Installation Frontend
echo -e "\n${YELLOW}[4/4] Préparation du Frontend Vite / Vite+ & Oxlint...${RESET}"
cd frontend
npm install --quiet
cd ..
echo -e "  ✔ Frontend et linter prêts !"

echo -e "\n${GREEN}==================================================================${RESET}"
echo -e "${GREEN}   Tout est prêt ! Pour lancer l'application en local :          ${RESET}"
echo -e "${GREEN}==================================================================${RESET}"
echo -e "\n1. Démarrer le backend (dans un 1er terminal) :"
echo -e "   ${CYAN}cd backend && source venv/bin/activate && uvicorn app.main:app --reload --port 8000${RESET}"
echo -e "\n2. Démarrer le frontend (dans un 2nd terminal) :"
echo -e "   ${CYAN}cd frontend && npm run dev${RESET}  (ou ${CYAN}vp dev${RESET} si vous utilisez Vite+)"
echo -e "\n3. Ouvrir votre navigateur sur : ${GREEN}http://localhost:5173${RESET}"
echo -e "\n4. Vérifier la qualité du code (Linters sans avertissements) :"
echo -e "   - Backend  : ${CYAN}ruff check backend/ && ruff format backend/${RESET}"
echo -e "   - Frontend : ${CYAN}cd frontend && npm run check${RESET}  (ou ${CYAN}vp check${RESET})\n"
