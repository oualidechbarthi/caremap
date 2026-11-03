// Valeurs partagées par toute l'interface (catégories, couleurs, réglages, textes d'état).
// Les icônes viennent de la bibliothèque lucide-react.
import { Activity, HeartPulse, ShoppingBasket, Stethoscope } from 'lucide-react';

// Position par défaut si aucune autre n'est connue
export const PARIS = { latitude: 48.8566, longitude: 2.3522, label: 'Paris, France' };

// Les 4 filtres « Services analysés » : identifiant (le même que le backend), texte, icône, couleur
export const CATEGORIES = [
  { id: 'all', label: 'Tous', icon: Activity, color: '#6366f1' },
  { id: 'pharmacy', label: 'Pharmacies', icon: HeartPulse, color: '#10b981' },
  { id: 'healthcare', label: 'Santé', icon: Stethoscope, color: '#3b82f6' },
  { id: 'food', label: 'Alimentation', icon: ShoppingBasket, color: '#f59e0b' },
];

// Raccourci : { pharmacy: '#10b981', healthcare: '#3b82f6', ... }
export const CATEGORY_COLORS = Object.fromEntries(CATEGORIES.map((item) => [item.id, item.color]));

// Rouge des zones « désert »
export const DESERT_COLOR = '#ef4444';

// Vitesse moyenne d'un piéton : 1,25 m/s (4,5 km/h), identique au backend
export const WALK_SPEED_M_PER_MIN = 75;
// Curseur du temps de marche : de 5 à 30 min, par pas de 5, 15 min par défaut
export const WALK_MINUTES = { min: 5, max: 30, step: 5, default: 15 };

// Tuiles OSM standard (sans clé d'API) ; le thème sombre est obtenu par un filtre CSS
export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';

export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Texte et couleur du badge en haut à droite selon l'état du téléchargement OpenStreetMap
export const OSM_STATUS = {
  ready: { label: 'Données à jour', tone: 'good' },
  loading: { label: 'Téléchargement OpenStreetMap…', tone: 'busy' },
  unavailable: { label: 'OpenStreetMap ne répond pas · données en cache', tone: 'warning' },
  zoom_in: { label: 'Zoomez pour charger ce quartier', tone: 'muted' },
};
