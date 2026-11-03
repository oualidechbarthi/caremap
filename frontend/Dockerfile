# Image Docker du frontend, construite en 2 étapes :
#   1. Node compile le code React en fichiers statiques (HTML, CSS, JS) dans dist/
#   2. nginx (petit serveur web) sert ces fichiers ; Node n'est plus dans l'image finale
# ---- Stage 1: build the React app with Vite ----
FROM node:20-alpine AS build

WORKDIR /app

# Les dépendances d'abord : Docker garde cette étape en cache tant que package.json ne change pas
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# Compilation de production (vite build) -> dossier dist/
RUN npm run build

# ---- Stage 2: serve the static files with nginx ----
FROM nginx:1.27-alpine

# Configuration de nginx et fichiers compilés récupérés de l'étape 1
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
