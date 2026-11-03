# 🌍 Mettre CareMap en ligne

Ce guide met CareMap sur un serveur Linux accessible depuis Internet, **en HTTPS** (le GPS des téléphones fonctionne alors), avec une seule commande Docker.

```text
Internet ──HTTPS──▶ Caddy (80/443, certificat automatique)
                     └──▶ nginx (frontend React) ──/api──▶ FastAPI (backend) ──▶ OpenStreetMap
```

Fichiers utilisés : [`docker-compose.prod.yml`](docker-compose.prod.yml), [`deploy/Caddyfile`](deploy/Caddyfile), [`.env.example`](.env.example).

---

## 1. Ce qu'il faut

| Élément | Minimum | Conseillé |
| :--- | :--- | :--- |
| Système | Ubuntu 22.04 ou 24.04 | Ubuntu 24.04 |
| Mémoire | 2 Go (+ 2 Go de swap) | 4 Go ou plus |
| Disque | 20 Go | 30 Go |
| Ports ouverts | 22 (SSH), 80, 443 | idem |

Les calculs de rues (« Autour de moi ») chargent des graphes en mémoire : en dessous de 2 Go, le backend risque de s'arrêter.

**Un nom de domaine n'est pas obligatoire.** Avec l'adresse IP du serveur, le service gratuit [sslip.io](https://sslip.io) donne une adresse qui accepte HTTPS : le serveur `51.38.12.34` devient **`51-38-12-34.sslip.io`**.

---

## 2. Obtenir un serveur

### Option A — Oracle Cloud « Always Free » (gratuit)

1. Créez un compte sur [oracle.com/cloud/free](https://www.oracle.com/cloud/free/). Une carte bancaire est demandée pour vérifier l'identité ; les ressources « Always Free » ne sont pas facturées.
2. **Compute → Instances → Create instance** :
   - Image : **Canonical Ubuntu 24.04**.
   - Shape : **Ampere (VM.Standard.A1.Flex)**, par exemple 2 OCPU et 12 Go de mémoire (dans la limite gratuite).
   - Ajoutez votre clé SSH publique (voir [étape 3](#3-se-connecter-au-serveur)).
   - Si le message « Out of capacity » s'affiche, réessayez plus tard ou dans une autre zone de disponibilité.
3. **Ouvrir les ports 80 et 443** (deux endroits chez Oracle) :
   - Sur la page de l'instance : **Subnet → Security List → Add Ingress Rules** : source `0.0.0.0/0`, protocole TCP, ports `80` puis `443`.
   - Sur le serveur lui-même (les images Ubuntu d'Oracle bloquent tout par défaut), une fois connecté :
     ```bash
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
     sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
     sudo netfilter-persistent save
     ```

### Option B — VPS payant (Hetzner, Contabo, DigitalOcean, OVH…)

1. Créez un serveur **Ubuntu 24.04** avec **au moins 2 Go de mémoire** (4 Go conseillés), en ajoutant votre clé SSH.
2. Si l'hébergeur propose un pare-feu, autorisez les ports **22, 80 et 443** en entrée.

Dans les deux cas, notez l'**adresse IP publique** du serveur.

---

## 3. Se connecter au serveur

Sur votre ordinateur, créez une clé SSH si vous n'en avez pas, et copiez la partie publique dans l'interface de l'hébergeur :

```bash
ssh-keygen -t ed25519            # Entrée pour tout accepter
cat ~/.ssh/id_ed25519.pub        # à coller chez l'hébergeur
```

Puis connectez-vous (l'utilisateur est `ubuntu` chez Oracle, souvent `root` ailleurs) :

```bash
ssh ubuntu@51.38.12.34
```

---

## 4. Installer Docker

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
exit                              # puis reconnectez-vous avec ssh
docker --version && docker compose version
```

**Serveur à 2 Go de mémoire :** ajoutez 2 Go de swap pour éviter les arrêts du backend.

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

---

## 5. Installer et lancer CareMap

```bash
git clone https://github.com/oualidechbarthi/caremap.git
cd caremap

cp .env.example .env
nano .env                         # mettez votre adresse, ex. DOMAIN=51-38-12-34.sslip.io

docker compose -f docker-compose.prod.yml up -d --build
```

La première construction prend 5 à 10 minutes. Ensuite, ouvrez **`https://51-38-12-34.sslip.io`** (votre adresse).

Vérifier que tout tourne :

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f caddy     # obtention du certificat HTTPS
docker compose -f docker-compose.prod.yml logs -f backend   # téléchargements OpenStreetMap
```

---

## 6. Utiliser son propre nom de domaine (facultatif)

1. Chez votre registraire (ex. un domaine `.ma` ou `.com`), créez un enregistrement DNS **A** : `caremap` → IP du serveur.
2. Attendez quelques minutes, puis sur le serveur :
   ```bash
   nano .env                        # DOMAIN=caremap.mondomaine.ma
   docker compose -f docker-compose.prod.yml up -d
   ```
Caddy obtient alors un nouveau certificat pour ce nom.

---

## 7. Mettre à jour après un `git push`

```bash
cd ~/caremap
git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Les données (`backend/data/`) et les certificats sont conservés.

**Sauvegarde du cache** (facultatif) :

```bash
tar czf caremap-data-$(date +%F).tar.gz backend/data
```

---

## 8. En cas de problème

| Symptôme | Cause probable | Solution |
| :--- | :--- | :--- |
| La page ne s'ouvre pas du tout | Ports 80/443 fermés | Pare-feu de l'hébergeur ; chez Oracle, Security List **et** `iptables` (étape 2) |
| Erreur de certificat dans `logs caddy` | Ports fermés, ou DNS pas encore à jour | Vérifier les ports ; attendre la propagation DNS ; relancer `up -d` |
| `required variable DOMAIN is missing` | Fichier `.env` absent | `cp .env.example .env` puis le compléter |
| « Backend injoignable » dans l'application | Backend arrêté (souvent manque de mémoire) | `logs backend` ; ajouter du swap ou un serveur plus grand |
| Le GPS ne marche pas sur téléphone | Adresse en `http://` | Toujours utiliser l'adresse `https://` |

---

## 9. Avant d'accueillir beaucoup de visiteurs

L'application utilise des services publics gratuits d'OpenStreetMap, prévus pour un usage modéré :

- **Fond de carte** : les tuiles `tile.openstreetmap.org` interdisent le trafic important. Pour un vrai public, passez à un fournisseur avec offre gratuite (MapTiler, Stadia Maps) : il suffit de changer `TILE_URL` dans `frontend/src/constants.js`.
- **Overpass, OSRM, Nominatim** : serveurs publics à usage raisonnable ; les caches de CareMap limitent déjà les appels. Pour un usage intensif, il faudra des serveurs dédiés.
- L'attribution **« © OpenStreetMap »** doit rester visible sur la carte (licence ODbL).
