// =============================================================================
// App.jsx : le composant principal de l'interface CareMap.
//
// Il contient :
//   - la carte (Leaflet) avec les lieux, les zones et les couches ;
//   - le panneau de gauche (mode, temps de marche, filtres, statistiques) ;
//   - la fiche d'un lieu (temps de trajet, bus/tram, bouton « Y aller ») ;
//   - les appels à l'API du backend (/api/explore, /api/nearby, /api/trip...).
//
// Organisation du fichier :
//   1. imports et petites fonctions d'aide (formatage, icônes, mini-carte)
//   2. le composant App : états (useState), appels API (useEffect), affichage (JSX)
// =============================================================================

// --- React et Leaflet (la bibliothèque de carte) ---
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
// --- Icônes (lucide-react) ---
import {
  AlertCircle,
  ArrowLeft,
  Bike,
  Bus,
  Car,
  Check,
  ChevronUp,
  Clock,
  Crosshair,
  ExternalLink,
  Footprints,
  Hexagon,
  Info,
  Layers,
  LocateFixed,
  MapPin,
  Minus,
  Moon,
  Navigation,
  Plus,
  ShieldCheck,
  Sun,
  TramFront,
  UserRound,
  X,
} from 'lucide-react';
import {
  Circle,
  CircleMarker,
  GeoJSON,
  MapContainer,
  Marker,
  Polygon,
  Polyline,
  TileLayer,
  Tooltip,
  useMapEvents,
} from 'react-leaflet';
// --- Nos composants et fichiers d'aide ---
import AccountModal from './components/AccountModal.jsx';
import CoverageGauge from './components/CoverageGauge.jsx';
import PopulationCard from './components/PopulationCard.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import SearchBox from './components/SearchBox.jsx';
import {
  CATEGORIES,
  CATEGORY_COLORS,
  DESERT_COLOR,
  OSM_STATUS,
  TILE_ATTRIBUTION,
  TILE_URL,
  WALK_MINUTES,
  WALK_SPEED_M_PER_MIN,
} from './constants.js';
import { readStorage, useAnimatedNumber, useDebouncedValue, writeStorage } from './hooks.js';
import { openingStatus } from './openingHours.js';
import { hexStyle, hexTooltip, metricKey } from './population.js';

// Les 3 vraies catégories (sans « Tous »), utilisées pour les statistiques
const STAT_CATEGORIES = CATEGORIES.filter((item) => item.id !== 'all');

/** Icône moto (absente de lucide-react), au même format que les autres icônes. */
function MotorbikeIcon({ size = 24, strokeWidth = 2, ...rest }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <circle cx="5" cy="17" r="3" />
      <circle cx="19" cy="17" r="3" />
      <path d="M5 17h4l3-5h5l2 5" />
      <path d="M14 7h2.5l2.5 5" />
      <path d="M8 12h4" />
    </svg>
  );
}

// Modes de trajet affichés dans la fiche d'un lieu (mode « Toute la zone »)
const TRIP_MODES = {
  walk: { label: 'À pied', icon: Footprints, color: '#6366f1' },
  bike: { label: 'Vélo', icon: Bike, color: '#10b981' },
  motorcycle: { label: 'Moto', icon: MotorbikeIcon, color: '#f59e0b' },
  car: { label: 'Voiture', icon: Car, color: '#3b82f6' },
};
// Couleurs par défaut des lignes de tram et de bus
const TRAM_COLOR = '#e11d48';
const BUS_COLOR = '#0ea5e9';

// Minutes -> texte lisible : « 12 min », « 1 h 05 », « 2 h »
function formatDuration(minutes) {
  if (minutes < 1) return '< 1 min';
  // Arrondi d'abord : 119,6 min = « 2 h », jamais « 1 h 60 »
  const total = Math.round(minutes);
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`;
}

// Couleur d'une ligne de bus/tram : celle d'OpenStreetMap si elle existe
const rideColor = (ride) => ride.colour || (ride.mode === 'tram' ? '#e11d48' : '#0ea5e9');

// Phrase qui explique un itinéraire en bus/tram (lignes, arrêts, correspondances)
function transitNote(option) {
  const rides = option.legs
    .filter((leg) => leg.type === 'ride')
    .map(
      (leg) =>
        `${leg.mode === 'tram' ? 'Tram' : 'Bus'} ${leg.line} de « ${leg.from.name} » à « ${leg.to.name} » (${leg.stops} arrêt${leg.stops > 1 ? 's' : ''})`
    );
  const extra = option.transfers > 0 ? ', 5 min comptées par correspondance' : '';
  return `${rides.join(', puis ')}. Temps hors attente à l’arrêt${extra}.`;
}

// GeoJSON donne [longitude, latitude] mais Leaflet attend [latitude, longitude] : on inverse
const toLatLngs = (coordinates) => coordinates.map(([longitude, latitude]) => [latitude, longitude]);

// --- Itinéraire confirmé (« Y aller ») : mini-carte du trajet ------------------------
// Petits ronds de départ et d'arrivée sur la mini-carte (dessinés en CSS)
const startIcon = L.divIcon({
  className: 'mini-pin mini-pin-start',
  html: '<span></span>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});
const endIcon = L.divIcon({
  className: 'mini-pin mini-pin-end',
  html: '<span></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

/**
 * Petite carte du trajet dans la fiche : départ (ma position), arrivée (le lieu)
 * et le chemin, coloré selon le mode. Pour le bus / tram : marche en pointillés,
 * chaque ligne dans sa couleur, et les arrêts où monter et descendre.
 */
function MiniRouteMap({ segments, from, to, endColor }) {
  // Tous les points du trajet : la mini-carte se cadre automatiquement pour tous les voir
  const points = [from, to, ...segments.flatMap((segment) => segment.positions)];
  const stops = segments.filter((segment) => segment.type === 'ride');
  return (
    <div className="mini-map">
      <MapContainer
        bounds={points}
        boundsOptions={{ padding: [26, 26], maxZoom: 17 }}
        zoomControl={false}
        attributionControl={false}
        scrollWheelZoom={false}
        className="mini-map-inner"
      >
        <TileLayer url={TILE_URL} />
        {/* 1er passage : un trait blanc plus large sous chaque segment (bordure du chemin) */}
        {segments.map((segment, index) => (
          <Polyline
            key={`casing-${index}`}
            positions={segment.positions}
            interactive={false}
            pathOptions={{ color: '#ffffff', weight: segment.type === 'ride' ? 9 : 7, opacity: 0.9, lineCap: 'round' }}
          />
        ))}
        {segments.map((segment, index) => (
          <Polyline
            key={`line-${index}`}
            positions={segment.positions}
            interactive={false}
            pathOptions={{
              color: segment.color,
              weight: segment.type === 'ride' ? 6 : 5,
              lineCap: 'round',
              dashArray: segment.dashed ? '2 9' : null,
            }}
          />
        ))}
        {stops.map((segment, index) => (
          <CircleMarker
            key={`stop-${index}`}
            center={segment.positions.at(0)}
            radius={5}
            interactive={false}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: segment.color, fillOpacity: 1 }}
          />
        ))}
        {stops.map((segment, index) => (
          <CircleMarker
            key={`alight-${index}`}
            center={segment.positions.at(-1)}
            radius={5}
            interactive={false}
            pathOptions={{ color: '#ffffff', weight: 2, fillColor: segment.color, fillOpacity: 1 }}
          />
        ))}
        {/* Marqueurs de départ (vous) et d'arrivée (le lieu) */}
        <Marker position={from} icon={startIcon} interactive={false} />
        <Marker position={to} icon={endIcon} interactive={false} />
      </MapContainer>
      <span className="mini-legend" style={{ '--color': endColor }}>
        <span className="mini-dot start" /> Vous
        <span className="mini-dot end" /> Arrivée
      </span>
    </div>
  );
}

// Lien « Ouvrir dans Google Maps » avec le même trajet et le bon mode de transport
const GOOGLE_TRAVEL_MODE = { walk: 'walking', bike: 'bicycling', motorcycle: 'driving', car: 'driving' };

function googleMapsUrl(from, to, mode) {
  const params = new URLSearchParams({
    api: '1',
    origin: `${from[0]},${from[1]}`,
    destination: `${to[0]},${to[1]}`,
    travelmode: GOOGLE_TRAVEL_MODE[mode] ?? 'transit',
  });
  return `https://www.google.com/maps/dir/?${params}`;
}

// Heure au format 14:05
function clockTime(date) {
  return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// Petite note sous le trajet choisi : explique d'où vient le temps affiché
function tripNote(mode, trip, transitOption) {
  if (transitOption) return transitNote(transitOption);
  if (trip?.method === 'estimate') return 'Serveur d’itinéraires indisponible : estimation à vol d’oiseau (+30 % de détour).';
  if (mode === 'walk') return 'Itinéraire piéton réel (OpenStreetMap), à 4,5 km/h.';
  if (mode === 'bike') return 'Itinéraire cyclable réel (OpenStreetMap).';
  if (mode === 'motorcycle') return 'Même itinéraire que la voiture, sans embouteillages.';
  return 'Itinéraire routier réel, sans embouteillages : comptez plus aux heures de pointe.';
}

// Le point bleu qui clignote = ma position
const userIcon = L.divIcon({
  className: 'user-pin',
  html: '<span class="user-pin-pulse"></span><span class="user-pin-dot"></span>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

// Composant invisible : écoute la carte et prévient App quand on la déplace,
// quand on clique (fermer la fiche) ou quand on fait un clic droit (« je suis ici »)
function MapEvents({ onViewportChange, onMapClick, onSetHome }) {
  const map = useMapEvents({
    moveend: () => onViewportChange(readViewport(map)),
    click: onMapClick,
    // Clic droit (ou appui long sur mobile) : « je suis ici »
    contextmenu: (event) => onSetHome(event.latlng.lat, event.latlng.lng),
  });

  useEffect(() => {
    // Au premier affichage : envoie tout de suite la vue de départ
    onViewportChange(readViewport(map));
  }, [map, onViewportChange]);

  return null;
}

// Rectangle visible de la carte (sud, ouest, nord, est) et niveau de zoom
function readViewport(map) {
  const bounds = map.getBounds();
  return {
    south: bounds.getSouth(),
    west: bounds.getWest(),
    north: bounds.getNorth(),
    east: bounds.getEast(),
    zoom: Math.round(map.getZoom()),
  };
}

// --- Géométrie « Autour de moi » ------------------------------------------------
// Rayon de la Terre et conversions degrés <-> radians
const EARTH_RADIUS_M = 6371008.8;
const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

/** Points d'un vrai cercle de `radius` mètres autour d'un point (pour le masque « désert »). */
function circleRing(lat, lon, radius, steps = 96) {
  const angular = radius / EARTH_RADIUS_M;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  // 96 points répartis tout autour du centre (formule de navigation « point à distance et cap »)
  return Array.from({ length: steps }, (_, i) => {
    const bearing = (2 * Math.PI * i) / steps;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing)
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
        Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2)
      );
    return [toDeg(lat2), toDeg(lon2)];
  });
}

/** Rectangle qui contient le cercle de marche (zone demandée au backend). */
function circleBounds(lat, lon, radius) {
  const dLat = toDeg(radius / EARTH_RADIUS_M);
  const dLon = dLat / Math.cos(toRad(lat));
  return { south: lat - dLat, north: lat + dLat, west: lon - dLon, east: lon + dLon };
}

// Tout le globe, percé du cercle de marche : ce qui reste en rouge est le désert
const WORLD_RING = [
  [-85, -179.9],
  [85, -179.9],
  [85, 179.9],
  [-85, 179.9],
];

// Petites fonctions d'affichage : « 7 min », « 850 m », « 1,2 km »
function formatMinutes(value) {
  return value < 1 ? '< 1 min' : `${Math.round(value)} min`;
}

function formatDistance(meters) {
  return meters >= 1000
    ? `${(meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`
    : `${Math.round(meters)} m`;
}

// Une ligne de statistique du panneau : icône, nom, nombre animé et barre proportionnelle
function StatRow({ category, count, max }) {
  const animated = useAnimatedNumber(count ?? 0);
  return (
    <div className="stat-row" style={{ '--color': category.color }}>
      <span className="stat-name">
        <category.icon size={15} />
        {category.label}
      </span>
      <strong>{Math.round(animated)}</strong>
      <span className="stat-bar">
        <span style={{ transform: `scaleX(${max ? (count ?? 0) / max : 0})` }} />
      </span>
    </div>
  );
}

/** Position réelle de l'appareil (GPS, ou Wi-Fi sur un ordinateur). */
function getGpsPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('unsupported'));
      return;
    }
    // API du navigateur : demande l'autorisation puis renvoie la position (timeout 10 s)
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          label: 'Votre position',
          source: 'gps',
        }),
      reject,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

// Message clair selon la raison de l'échec du GPS (code 1 = refusé, code 3 = trop long)
function gpsErrorMessage(error) {
  const fallback = ' Cliquez sur « Sur la carte » pour indiquer où vous êtes.';
  // Le navigateur ne donne le GPS qu'en HTTPS ou sur « localhost » (quel que soit le port : 5173, 8080...)
  if (!window.isSecureContext) {
    const port = window.location.port ? `:${window.location.port}` : '';
    return `La localisation précise exige HTTPS ou localhost (ouvrez http://localhost${port}).${fallback}`;
  }
  if (error?.code === 1) return `Localisation refusée par le navigateur (autorisez-la via l'icône du cadenas).${fallback}`;
  if (error?.code === 3) return `La localisation a pris trop de temps.${fallback}`;
  return `Cet appareil ne fournit pas de position précise (fréquent sur un PC sans GPS).${fallback}`;
}

/** Position choisie à la main, mémorisée d'une visite à l'autre. */
function readSavedHome() {
  try {
    const saved = JSON.parse(readStorage('uw-home', 'null'));
    return Number.isFinite(saved?.latitude) && Number.isFinite(saved?.longitude) ? saved : null;
  } catch {
    return null;
  }
}

/** Dernière vue de la carte (centre + zoom), pour rouvrir là où on s'était arrêté. */
function readSavedView() {
  try {
    const saved = JSON.parse(readStorage('uw-view', 'null'));
    return Number.isFinite(saved?.latitude) && Number.isFinite(saved?.longitude) && Number.isFinite(saved?.zoom)
      ? saved
      : null;
  } catch {
    return null;
  }
}

// Point de départ neutre (le monde entier) : jamais une ville précise par défaut
const WORLD_VIEW = { latitude: 20, longitude: 0, zoom: 3 };

/** Vue de départ, lue une seule fois : ma position mémorisée, sinon ma dernière vue, sinon le monde. */
function initialView() {
  const home = readSavedHome();
  if (home) return { latitude: home.latitude, longitude: home.longitude, zoom: 16 };
  return readSavedView() ?? WORLD_VIEW;
}

// --- Mode confidentiel ----------------------------------------------------------
// La position est arrondie sur une grille de 0,005° (~500 m) AVANT d'être utilisée :
// la position exacte ne quitte jamais le téléphone et n'est jamais enregistrée.
const PRIVACY_GRID_DEG = 0.005;
const roundToGrid = (value) => Math.round(value / PRIVACY_GRID_DEG) * PRIVACY_GRID_DEG;

/** Version « floutée » d'une position (mode confidentiel). */
function blurLocation(location) {
  return {
    ...location,
    latitude: roundToGrid(location.latitude),
    longitude: roundToGrid(location.longitude),
    accuracy: Math.max(location.accuracy ?? 0, 400),
    approximate: true,
  };
}

// Texte sous « Ma position » : d'où vient la position et sa précision
function describeSource(location) {
  if (!location) return 'Recherche de votre position…';
  if (location.approximate) return 'Mode confidentiel · arrondie à ~500 m, non enregistrée';
  if (location.source === 'manual') return 'Choisie sur la carte';
  if (location.source === 'ip') return 'Approximative (adresse IP) · souvent une autre ville';
  if (location.accuracy > 1000) return `Approximative (± ${formatDistance(location.accuracy)})`;
  return `Précise (± ${formatDistance(location.accuracy ?? 0)})`;
}

// =============================================================================
// Composant principal
// =============================================================================
export default function App() {
  // --- États (useState) : les données qui, en changeant, mettent l'écran à jour ---
  // map = l'objet carte Leaflet ; startView = centre et zoom au chargement
  const [map, setMap] = useState(null);
  const [startView] = useState(initialView);
  // Lu une seule fois au chargement, avant que la carte n'enregistre sa propre vue
  const [hadSavedView] = useState(() => Boolean(readSavedView()));
  const [theme, setTheme] = useState(() =>
    readStorage(
      'uw-theme',
      window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    )
  );
  // Fenêtre « Comment ça marche » ouverte automatiquement à la première visite
  const [showIntro, setShowIntro] = useState(() => readStorage('uw-intro-seen', '') !== '1');
  // Sur mobile, le panneau démarre replié pour laisser voir la carte
  const [sheetOpen, setSheetOpen] = useState(() => !window.matchMedia?.('(max-width: 720px)').matches);

  // Filtre de catégorie choisi (Tous / Pharmacies / Santé / Alimentation)
  const [category, setCategory] = useState('all');
  // « me » : seulement ce qui est à X min de ma position ; « city » : analyse de toute la zone visible
  const [mode, setMode] = useState(() => (readStorage('uw-mode', 'me') === 'city' ? 'city' : 'me'));
  // minutes = curseur de marche ; viewport = zone visible ; data = dernière réponse du backend
  const [minutes, setMinutes] = useState(WALK_MINUTES.default);
  const [viewport, setViewport] = useState(null);
  const [refreshTick, setRefreshTick] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [apiError, setApiError] = useState('');

  // Ma position et l'état de sa recherche ; picking = « cliquez sur la carte pour choisir »
  const [userLocation, setUserLocation] = useState(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [picking, setPicking] = useState(false);
  // Pas de GPS et aucune position mémorisée : on demande « Où êtes-vous ? »
  const [askLocation, setAskLocation] = useState(false);
  // Lieu sélectionné (fiche ouverte)
  const [selected, setSelected] = useState(null);

  // Mode « Toute la zone » : temps de trajet vers le lieu choisi + couche bus et tram
  const [trip, setTrip] = useState(null);
  const [tripTick, setTripTick] = useState(0);
  const [tripMode, setTripMode] = useState('walk');
  const [showTransit, setShowTransit] = useState(() => readStorage('uw-transit', '') === '1');
  // Analyse H3 : population et temps d'accès par hexagone (mode « Toute la zone »)
  const [showPopulation, setShowPopulation] = useState(() => readStorage('uw-population', '') === '1');
  const [analysisData, setAnalysisData] = useState(null);
  const [analysisTick, setAnalysisTick] = useState(0);
  const [transitData, setTransitData] = useState(null);
  const [transitTick, setTransitTick] = useState(0);
  // useRef garde une valeur sans redessiner l'écran (ici : le trajet déjà cadré sur la carte)
  const fittedTripRef = useRef('');
  // « Y aller » : l'itinéraire choisi est confirmé, la fiche montre les instructions
  const [navigating, setNavigating] = useState(false);
  // Comptes : jeton de connexion (gardé dans le navigateur) et compte connecté
  const [token, setToken] = useState(() => readStorage('uw-token', ''));
  const [account, setAccount] = useState(null);
  // Fenêtre « Mon compte » : null = fermée, sinon le type de compte proposé ('citizen' ou 'pro')
  const [accountModal, setAccountModal] = useState(null);
  // Mode confidentiel : position arrondie à ~500 m, jamais enregistrée, pas de GPS ni d'IP automatiques
  const [privacy, setPrivacy] = useState(() => readStorage('uw-privacy', '') === '1');
  // Heure courante, rafraîchie chaque minute (ouvert / fermé, heure d'arrivée)
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    // --- Effets (useEffect) : code exécuté quand certaines valeurs changent ---
    // Met à jour l'heure toutes les 60 secondes
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    // Les réglages sont mémorisés dans le navigateur (localStorage) pour la prochaine visite
    writeStorage('uw-mode', mode);
  }, [mode]);

  useEffect(() => {
    writeStorage('uw-transit', showTransit ? '1' : '');
  }, [showTransit]);

  useEffect(() => {
    writeStorage('uw-population', showPopulation ? '1' : '');
  }, [showPopulation]);

  // Mémorise la vue de la carte (centre + zoom) pour la prochaine visite
  // (pas en mode confidentiel : la vue pourrait révéler le quartier de l'utilisateur)
  useEffect(() => {
    if (!viewport || privacy) return;
    writeStorage(
      'uw-view',
      JSON.stringify({
        latitude: (viewport.south + viewport.north) / 2,
        longitude: (viewport.west + viewport.east) / 2,
        zoom: viewport.zoom,
      })
    );
  }, [viewport, privacy]);

  // Mode confidentiel activé : on efface tout ce qui a été mémorisé et on arrondit la position actuelle
  useEffect(() => {
    writeStorage('uw-privacy', privacy ? '1' : '');
    if (!privacy) return;
    writeStorage('uw-home', 'null');
    writeStorage('uw-view', 'null');
    setUserLocation((current) => (current && !current.approximate ? blurLocation(current) : current));
  }, [privacy]);

  // Au chargement (ou après connexion) : quel compte correspond au jeton ? (GET /api/auth/me)
  useEffect(() => {
    if (!token) {
      setAccount(null);
      return undefined;
    }
    const controller = new AbortController();
    fetch('/api/auth/me', { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { user: null }))
      .then((result) => {
        setAccount(result.user);
        // Jeton expiré ou invalide : on l'oublie
        if (!result.user) {
          setToken('');
          writeStorage('uw-token', '');
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [token]);

  const isPro = account?.role === 'pro';

  // Connexion réussie (appelée par AccountModal) : on garde le jeton et on ferme la fenêtre
  const signIn = useCallback((newToken, user) => {
    writeStorage('uw-token', newToken);
    setToken(newToken);
    setAccount(user);
    setAccountModal(null);
  }, []);

  // Déconnexion : le jeton est simplement oublié par le navigateur
  const signOut = useCallback(() => {
    writeStorage('uw-token', '');
    setToken('');
    setAccount(null);
    setAccountModal(null);
  }, []);

  useEffect(() => {
    // Thème clair / sombre : appliqué à la page entière (le CSS lit data-theme)
    document.documentElement.dataset.theme = theme;
    writeStorage('uw-theme', theme);
  }, [theme]);

  // --- Chargement des données de la zone visible --------------------------------
  // On attend que l'utilisateur arrête de bouger le curseur avant de redemander au serveur
  const debouncedMinutes = useDebouncedValue(minutes, 300);
  const nearMode = mode === 'me' && Boolean(userLocation);
  const reachRadius = debouncedMinutes * WALK_SPEED_M_PER_MIN;
  // query = ce qu'il faut demander au backend selon le mode (useMemo : recalculé seulement si besoin)
  const query = useMemo(() => {
    if (nearMode) {
      // Mode « Autour de moi » : le backend calcule ce qui est atteignable le long des rues
      // depuis ma position, quelle que soit la partie de la carte affichée.
      return {
        kind: 'near',
        lat: userLocation.latitude,
        lon: userLocation.longitude,
        category,
        minutes: debouncedMinutes,
      };
    }
    // « Toute la zone » : pas de curseur, critère fixe de la ville du quart d'heure (15 min)
    return viewport && { kind: 'zone', ...viewport, category, minutes: WALK_MINUTES.default };
  }, [nearMode, userLocation, viewport, category, debouncedMinutes]);
  // Pendant qu'on fait glisser la carte, on attend 200 ms d'immobilité avant d'appeler l'API
  const debouncedQuery = useDebouncedValue(query, 200);

  useEffect(() => {
    if (!debouncedQuery) return undefined;

    // Appel au backend : /api/nearby (« Autour de moi ») ou /api/explore (« Toute la zone »).
    // AbortController annule la requête précédente si la carte bouge entre-temps.
    const controller = new AbortController();
    const { kind } = debouncedQuery;
    const url =
      kind === 'near'
        ? `/api/nearby?${new URLSearchParams({
            lat: debouncedQuery.lat,
            lon: debouncedQuery.lon,
            minutes: debouncedQuery.minutes,
            category: debouncedQuery.category,
          })}`
        : `/api/explore?${new URLSearchParams({
            min_lat: debouncedQuery.south,
            min_lon: debouncedQuery.west,
            max_lat: debouncedQuery.north,
            max_lon: debouncedQuery.east,
            zoom: debouncedQuery.zoom,
            category: debouncedQuery.category,
            minutes: debouncedQuery.minutes,
          })}`;

    setLoading(true);
    fetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}.`);
        return response.json();
      })
      .then((result) => {
        setData({ ...result, kind });
        setApiError('');
        setLoading(false);
      })
      .catch((error) => {
        if (error.name === 'AbortError') return;
        setApiError(`${error.message || 'Connexion impossible.'} Le backend tourne-t-il sur le port 8000 ?`);
        setLoading(false);
      });

    // Nettoyage : annule la requête si la vue change avant la réponse
    return () => controller.abort();
  }, [debouncedQuery, refreshTick]);

  // Pendant les téléchargements OSM (lieux ou rues) en arrière-plan, on redemande toutes les 3 s
  useEffect(() => {
    if (data?.osm_status !== 'loading' && data?.streets_status !== 'loading') return undefined;
    const timer = setTimeout(() => setRefreshTick((tick) => tick + 1), 3000);
    return () => clearTimeout(timer);
  }, [data]);

  // --- Localisation -----------------------------------------------------------
  // Déplace la carte avec une animation de vol jusqu'au point demandé
  const goTo = useCallback(
    (latitude, longitude, zoom = 15) => {
      map?.flyTo([latitude, longitude], zoom, { duration: 1.4, easeLinearity: 0.2 });
    },
    [map]
  );

  // Position approximative par l'adresse IP (via /api/locate du backend)
  const locateByIp = useCallback(async () => {
    const response = await fetch('/api/locate');
    if (!response.ok) throw new Error(`Le service de localisation a répondu ${response.status}.`);
    const result = await response.json();
    return {
      latitude: result.latitude,
      longitude: result.longitude,
      label: `${result.city}, ${result.country}`,
      source: 'ip',
    };
  }, []);

  // Bouton GPS : position réelle de l'appareil (remplace une position choisie à la main)
  const locateWithGps = useCallback(async () => {
    setLocating(true);
    setLocationError('');
    try {
      const exact = await getGpsPosition();
      // En mode confidentiel, la position est arrondie tout de suite (l'exacte n'est gardée nulle part)
      const found = privacy ? blurLocation(exact) : exact;
      writeStorage('uw-home', 'null');
      setUserLocation(found);
      setAskLocation(false);
      goTo(found.latitude, found.longitude, 16);
    } catch (gpsError) {
      setLocationError(gpsErrorMessage(gpsError));
    } finally {
      setLocating(false);
    }
  }, [goTo, privacy]);

  // « Sur la carte » : l'utilisateur clique là où il se trouve
  const setManualHome = useCallback(
    (latitude, longitude, label = 'Ma position') => {
      const chosen = { latitude, longitude, label, source: 'manual' };
      const home = privacy ? blurLocation(chosen) : chosen;
      // Mémorisée pour la prochaine visite, sauf en mode confidentiel
      if (!privacy) writeStorage('uw-home', JSON.stringify(home));
      setUserLocation(home);
      setPicking(false);
      setAskLocation(false);
      setLocationError('');
      goTo(home.latitude, home.longitude, Math.max(map?.getZoom() ?? 16, 16));
    },
    [goTo, map, privacy]
  );

  // Au démarrage :
  //  1. position choisie à la main lors d'une visite précédente, sinon
  //  2. position par IP (rapide mais souvent fausse : le fournisseur d'accès
  //     peut passer par une autre ville), remplacée par
  //  3. la position réelle de l'appareil (GPS / Wi-Fi) si le navigateur la donne.
  useEffect(() => {
    if (!map) return undefined;

    // 1. Une position choisie à la main existe : on l'utilise directement
    const saved = readSavedHome();
    if (saved) {
      setUserLocation(saved);
      map.setView([saved.latitude, saved.longitude], 16);
      return undefined;
    }

    // Mode confidentiel : rien d'automatique (ni GPS, ni adresse IP) ; on demande à l'utilisateur
    if (readStorage('uw-privacy', '') === '1') {
      setAskLocation(true);
      return undefined;
    }

    // cancelled : évite de modifier l'état si le composant a changé entre-temps
    let cancelled = false;
    let gotDevicePosition = false;

    // L'adresse IP désigne souvent la ville du fournisseur d'accès (au Maroc : Meknès…),
    // jamais « votre position ». Première visite seulement : elle sert à montrer le pays
    // (zoom 6), pas une ville. Les visites suivantes rouvrent sur la dernière vue.
    if (!hadSavedView) {
      locateByIp()
        .then((found) => {
          if (!cancelled && !gotDevicePosition) map.setView([found.latitude, found.longitude], 6);
        })
        .catch(() => {});
    }

    // 3. Position réelle de l'appareil : elle remplace tout le reste si elle arrive
    getGpsPosition()
      .then((found) => {
        if (cancelled) return;
        gotDevicePosition = true;
        setUserLocation(found);
        goTo(found.latitude, found.longitude, 16);
      })
      .catch(() => {
        // Pas de position précise (PC sans GPS, refus…) : on demande à l'utilisateur
        if (!cancelled) setAskLocation(true);
      });

    return () => {
      cancelled = true;
    };
  }, [map, locateByIp, goTo, hadSavedView]);

  // Mode « Autour de moi » : la carte cadre le cercle de marche
  const fitReach = useCallback(() => {
    if (!map || !userLocation) return;
    const bounds = circleBounds(userLocation.latitude, userLocation.longitude, reachRadius);
    const mobile = window.matchMedia?.('(max-width: 720px)').matches;
    map.flyToBounds(
      [
        [bounds.south, bounds.west],
        [bounds.north, bounds.east],
      ],
      {
        paddingTopLeft: mobile ? [16, 16] : [430, 40],
        paddingBottomRight: mobile ? [16, 240] : [40, 40],
        duration: 1.2,
      }
    );
  }, [map, userLocation, reachRadius]);

  useEffect(() => {
    // Recadre la carte dès qu'on passe en mode « Autour de moi » ou que le rayon change
    if (nearMode) fitReach();
  }, [nearMode, fitReach]);

  useEffect(() => {
    // En mode « choisir sur la carte », la touche Échap annule
    if (!picking) return undefined;
    const onKey = (event) => event.key === 'Escape' && setPicking(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [picking]);

  // Clic sur la carte : choisit ma position (si on est en train de la choisir) ou ferme la fiche
  const handleMapClick = useCallback(
    (event) => {
      if (picking) setManualHome(event.latlng.lat, event.latlng.lng);
      else setSelected(null);
    },
    [picking, setManualHome]
  );

  // --- Valeurs dérivées --------------------------------------------------------
  const stats = data?.stats;
  // Le score n'existe que pour une réponse « Toute la zone » (sinon : NaN %)
  const zoneStats = data?.kind === 'zone' ? stats : null;
  const coverageKnown = Number.isFinite(zoneStats?.desert_percentage);
  const coverage = coverageKnown ? Math.max(0, 100 - zoneStats.desert_percentage) : 0;
  // pending = pas de score à afficher (vue trop large ou données en attente)
  const pending = !coverageKnown || (data.osm_status === 'zoom_in' && zoneStats.total_amenities === 0);
  const osmStatus = OSM_STATUS[data?.osm_status] ?? OSM_STATUS.ready;
  const statCategories = CATEGORIES.filter((item) => item.id !== 'all');
  // Nombre de services par catégorie (barres du panneau)
  const counts = {
    pharmacy: stats?.pharmacies ?? 0,
    healthcare: stats?.healthcare ?? 0,
    food: stats?.food ?? 0,
  };
  const maxCount = Math.max(...Object.values(counts), 1);
  const categoryIndex = CATEGORIES.findIndex((item) => item.id === category);
  // Position du curseur en % (pour colorer la partie gauche de la barre)
  const sliderPct = ((minutes - WALK_MINUTES.min) / (WALK_MINUTES.max - WALK_MINUTES.min)) * 100;

  // Lieux réellement accessibles à pied depuis ma position, du plus proche au plus loin.
  // Le temps de marche vient du backend (le long des rues quand le plan est disponible).
  const nearData = nearMode && data?.kind === 'near' ? data : null;
  const reach = useMemo(() => {
    if (!nearData) return null;
    const places = nearData.amenities.features
      .filter((feature) => feature.properties.reachable)
      .map((feature) => ({
        feature,
        minutes: feature.properties.walk_minutes,
        distance: feature.properties.walk_minutes * WALK_SPEED_M_PER_MIN,
      }))
      .sort((a, b) => a.minutes - b.minutes);
    const byCategory = Object.fromEntries(
      STAT_CATEGORIES.map((item) => [item.id, places.filter((place) => place.feature.properties.category === item.id)])
    );
    return { places, byCategory };
  }, [nearData]);

  // Catégories vérifiées et celles qui manquent dans mon rayon de marche
  const checkedCategories = category === 'all' ? statCategories : statCategories.filter((item) => item.id === category);
  const missing = reach ? checkedCategories.filter((item) => reach.byCategory[item.id].length === 0) : [];
  const reachLoading = nearMode && (!nearData || nearData.osm_status === 'loading');
  // Couleur du résumé : vert = tout est accessible, rouge = il manque au moins un service
  const reachTone = !reach || reachLoading ? 'busy' : missing.length === 0 ? 'good' : 'bad';
  // Lieux dessinés sur la carte : seulement ceux atteignables en « Autour de moi »
  const shownPlaces = nearMode ? (reach?.places ?? []).map((place) => place.feature) : data?.amenities?.features ?? [];
  const streetsReady = nearData?.method === 'streets';
  // Clé unique de la zone atteignable : quand elle change, Leaflet redessine la forme
  const reachKey = nearData
    ? `${nearData.origin.lat}-${nearData.origin.lon}-${nearData.stats.walk_minutes}-${nearData.method}`
    : '';

  // État affiché en haut à droite : en mode « Autour de moi », on parle surtout des rues
  let statusInfo = loading && !data ? { label: 'Chargement…', tone: 'busy' } : osmStatus;
  if (nearData && nearData.osm_status !== 'loading') {
    statusInfo = streetsReady
      ? { label: 'Temps de marche calculés le long des rues', tone: 'good' }
      : nearData.streets_status === 'loading'
        ? { label: 'Téléchargement du plan des rues…', tone: 'busy' }
        : { label: 'Plan des rues indisponible · estimation', tone: 'warning' };
  }

  // --- Trajet vers le lieu choisi (mode « Toute la zone ») ---------------------------
  // Ma position + le lieu choisi = le trajet à calculer
  const tripQuery = useMemo(
    () =>
      selected && userLocation
        ? {
            key: `${selected.properties.id}|${userLocation.latitude}|${userLocation.longitude}`,
            from_lat: userLocation.latitude,
            from_lon: userLocation.longitude,
            to_lat: selected.geometry.coordinates[1],
            to_lon: selected.geometry.coordinates[0],
          }
        : null,
    [selected, userLocation]
  );
  const tripKey = tripQuery?.key ?? '';

  useEffect(() => {
    // Nouveau lieu : on revient au mode « À pied » et on quitte la navigation
    setTripMode('walk');
    setNavigating(false);
  }, [tripKey]);

  useEffect(() => {
    if (!tripQuery) return undefined;
    const controller = new AbortController();
    // Appel à /api/trip : temps par mode + itinéraires bus/tram
    const { key, ...coords } = tripQuery;
    fetch(`/api/trip?${new URLSearchParams(coords)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}.`);
        return response.json();
      })
      .then((result) => setTrip({ ...result, key }))
      .catch((error) => {
        if (error.name !== 'AbortError') setTrip({ key, error: true });
      });
    return () => controller.abort();
  }, [tripQuery, tripTick]);

  // On ignore une réponse qui concernerait un lieu précédent
  const currentTrip = trip && trip.key === tripKey ? trip : null;
  const transitInfo = currentTrip?.transit;
  // Itinéraires bus / tram déjà triés du plus rapide au plus lent par le backend
  const transitOptions = transitInfo?.options ?? [];
  // tripMode = 'walk', 'bike', 'motorcycle', 'car' ou 't0', 't1'... (n° de l'itinéraire bus/tram)
  const activeTransit = tripMode.startsWith('t') ? (transitOptions[Number(tripMode.slice(1))] ?? null) : null;
  const activeTrip = currentTrip?.trips?.find((item) => item.mode === tripMode) ?? null;
  // Tracé de l'itinéraire bus / tram choisi : marche en pointillés, lignes en couleur
  const transitSegments = useMemo(() => {
    if (!activeTransit || !tripQuery) return [];
    let previous = [tripQuery.from_lat, tripQuery.from_lon];
    return activeTransit.legs.map((leg) => {
      const positions =
        leg.type === 'ride' ? leg.path : [previous, [leg.to.lat, leg.to.lon]];
      previous = positions.at(-1);
      return { type: leg.type, positions, color: leg.type === 'ride' ? rideColor(leg) : TRIP_MODES.walk.color };
    });
  }, [activeTransit, tripQuery]);

  // Choix confirmable par « Y aller » : le mode sélectionné dans la fiche
  // goChoice = le trajet choisi, au même format pour tous les modes (affiché par « Y aller »)
  let goChoice = null;
  if (activeTransit) {
    const rides = activeTransit.legs.filter((leg) => leg.type === 'ride');
    goChoice = {
      label: rides.map((ride) => `${ride.mode === 'tram' ? 'Tram' : 'Bus'} ${ride.line}`).join(' + '),
      icon: rides[0].mode === 'tram' ? TramFront : Bus,
      color: rideColor(rides[0]),
      minutes: activeTransit.total_min,
      distance: null,
      segments: transitSegments.map((segment) => ({ ...segment, dashed: segment.type !== 'ride' })),
      note: 'Temps hors attente à l’arrêt.',
    };
  } else if (activeTrip) {
    const config = TRIP_MODES[activeTrip.mode];
    goChoice = {
      label: config.label,
      icon: config.icon,
      color: config.color,
      minutes: activeTrip.duration_min,
      distance: activeTrip.distance_m,
      segments: [
        {
          type: 'route',
          positions: toLatLngs(activeTrip.geometry.coordinates),
          color: config.color,
          dashed: activeTrip.method === 'estimate',
        },
      ],
      note: activeTrip.method === 'estimate' ? 'Estimation à vol d’oiseau : itinéraire réel indisponible.' : '',
    };
  }
  // Heure d'arrivée estimée = maintenant + durée du trajet
  const arrival = goChoice ? clockTime(new Date(now.getTime() + goChoice.minutes * 60_000)) : '';

  // Itinéraire confirmé : la carte cadre tout le trajet
  useEffect(() => {
    if (!navigating || !map) return;
    const points = activeTrip
      ? toLatLngs(activeTrip.geometry.coordinates)
      : transitSegments.flatMap((segment) => segment.positions);
    if (points.length < 2) return;
    const mobile = window.matchMedia?.('(max-width: 720px)').matches;
    map.flyToBounds(points, {
      paddingTopLeft: mobile ? [16, 360] : [430, 40],
      paddingBottomRight: mobile ? [16, 40] : [40, 380],
      maxZoom: 17,
      duration: 1.2,
    });
  }, [navigating, map, activeTrip, transitSegments]);

  // Ouvert / fermé pour chaque lieu affiché (tag OSM opening_hours)
  const hoursById = useMemo(() => {
    const result = new Map();
    for (const feature of shownPlaces) {
      result.set(feature.properties.id, openingStatus(feature.properties.opening_hours, now));
    }
    return result;
  }, [shownPlaces, now]);
  // Horaires du lieu dont la fiche est ouverte
  const selectedHours = selected ? openingStatus(selected.properties.opening_hours, now) : null;

  // Arrêts de bus et de tram encore en téléchargement : on redemande toutes les 3 s
  useEffect(() => {
    if (transitInfo?.status !== 'loading') return undefined;
    const timer = setTimeout(() => setTripTick((tick) => tick + 1), 3000);
    return () => clearTimeout(timer);
  }, [transitInfo]);

  // À l'arrivée des itinéraires, la carte montre le trajet entier (une fois par lieu)
  useEffect(() => {
    if (!map || !currentTrip?.trips || !tripQuery || fittedTripRef.current === currentTrip.key) return;
    fittedTripRef.current = currentTrip.key;
    const walk = currentTrip.trips.find((item) => item.mode === 'walk');
    const points = [
      [tripQuery.from_lat, tripQuery.from_lon],
      [tripQuery.to_lat, tripQuery.to_lon],
      ...(walk ? toLatLngs(walk.geometry.coordinates) : []),
    ];
    const mobile = window.matchMedia?.('(max-width: 720px)').matches;
    map.flyToBounds(points, {
      paddingTopLeft: mobile ? [16, 320] : [430, 40],
      paddingBottomRight: mobile ? [16, 40] : [40, 330],
      maxZoom: 17,
      duration: 1.2,
    });
  }, [map, currentTrip, tripQuery]);

  // --- Couche « Bus et tram » ---------------------------------------------------------
  // La couche ne se charge qu'en mode « Toute la zone » et si l'interrupteur est activé
  const debouncedViewport = useDebouncedValue(viewport, 400);
  const transitQuery = !nearMode && showTransit ? debouncedViewport : null;

  useEffect(() => {
    if (!transitQuery) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({
      min_lat: transitQuery.south,
      min_lon: transitQuery.west,
      max_lat: transitQuery.north,
      max_lon: transitQuery.east,
      zoom: transitQuery.zoom,
    });
    fetch(`/api/transit?${params}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}.`);
        return response.json();
      })
      .then((result) => setTransitData({ ...result, zoom: transitQuery.zoom }))
      .catch((error) => {
        if (error.name !== 'AbortError') setTransitData({ status: 'unavailable', stops: [], tram_lines: [] });
      });
    return () => controller.abort();
  }, [transitQuery, transitTick]);

  useEffect(() => {
    if (transitData?.status !== 'loading') return undefined;
    const timer = setTimeout(() => setTransitTick((tick) => tick + 1), 3000);
    return () => clearTimeout(timer);
  }, [transitData]);

  // Texte sous l'interrupteur « Bus et tram » selon l'état du chargement
  const transitShown = !nearMode && showTransit && transitData;
  const tramStopCount = transitShown ? transitData.stops.filter((stop) => stop.kind === 'tram').length : 0;
  const busStopCount = transitShown ? transitData.stops.filter((stop) => stop.kind === 'bus').length : 0;
  let transitText = 'Afficher les lignes de tram et les arrêts';
  if (showTransit) {
    if (!transitData || transitData.status === 'loading') transitText = 'Téléchargement des arrêts…';
    else if (transitData.status === 'zoom_in') transitText = 'Zoomez pour voir les arrêts';
    else if (transitData.status === 'unavailable') transitText = 'OpenStreetMap ne répond pas, réessai bientôt';
    else
      transitText = `${tramStopCount} station${tramStopCount > 1 ? 's' : ''} de tram · ${
        transitData.zoom >= 15 ? `${busStopCount} arrêt${busStopCount > 1 ? 's' : ''} de bus` : 'zoomez pour les bus'
      }`;
  }

  // --- Analyse H3 : population et accès, hexagone par hexagone -----------------------
  // Appel à /api/analysis quand la couche « Population (H3) » est activée (comptes pro seulement)
  const analysisQuery = !nearMode && showPopulation && isPro ? debouncedViewport : null;

  useEffect(() => {
    if (!analysisQuery) return undefined;
    const controller = new AbortController();
    const params = new URLSearchParams({
      min_lat: analysisQuery.south,
      min_lon: analysisQuery.west,
      max_lat: analysisQuery.north,
      max_lon: analysisQuery.east,
      zoom: analysisQuery.zoom,
      minutes: WALK_MINUTES.default,
    });
    // Le jeton est envoyé dans l'en-tête Authorization : le backend vérifie que c'est un compte pro
    fetch(`/api/analysis?${params}`, { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } })
      .then((response) => {
        if (response.status === 401 || response.status === 403) return { status: 'forbidden' };
        if (!response.ok) throw new Error(`Le serveur a répondu ${response.status}.`);
        return response.json();
      })
      .then((result) => setAnalysisData(result))
      .catch((error) => {
        if (error.name !== 'AbortError') setAnalysisData({ status: 'error' });
      });
    return () => controller.abort();
  }, [analysisQuery, analysisTick, token]);

  // Lieux ou population encore en téléchargement : on redemande toutes les 3 s
  useEffect(() => {
    if (analysisData?.osm_status !== 'loading' && analysisData?.population_status !== 'loading') return undefined;
    const timer = setTimeout(() => setAnalysisTick((tick) => tick + 1), 3000);
    return () => clearTimeout(timer);
  }, [analysisData]);

  // Données prêtes à dessiner ; hexKey = temps à colorer selon le filtre (t_all, t_pharmacy...)
  const analysisShown =
    !nearMode && isPro && showPopulation && analysisData?.status === 'ready' && analysisData.hexagons;
  const hexKey = metricKey(category);
  const hexFeatures = analysisShown ? analysisData.hexagons.features : [];
  // Population de l'hexagone le plus peuplé (sert à régler l'opacité des autres)
  const maxHexPopulation = useMemo(
    () => hexFeatures.reduce((max, feature) => Math.max(max, feature.properties.population ?? 0), 0),
    [hexFeatures]
  );
  // Texte sous l'interrupteur « Population (H3) » selon l'état du chargement
  let populationText = 'Habitants et temps d’accès par hexagone';
  if (showPopulation) {
    if (!analysisData) populationText = 'Calcul en cours…';
    else if (analysisData.status === 'zoom_in') populationText = 'Zoomez pour analyser le quartier';
    else if (analysisData.status === 'error') populationText = 'Analyse indisponible, réessayez';
    else if (analysisData.status === 'forbidden') populationText = 'Réservé aux comptes pro';
    else if (analysisData.population_status === 'loading') populationText = 'Téléchargement de la population…';
    else if (analysisData.osm_status === 'loading') populationText = 'Téléchargement des lieux…';
    else if (analysisData.population_status === 'ready')
      populationText = `${analysisData.summary?.cells ?? 0} hexagones · ${analysisData.summary?.area_km2 ?? 0} km²`;
    else populationText = 'Population indisponible ici · temps d’accès seuls';
  }

  // Ferme la fenêtre d'introduction et retient qu'elle a déjà été vue
  const closeIntro = useCallback(() => {
    setShowIntro(false);
    writeStorage('uw-intro-seen', '1');
  }, []);

  return (
    // ===========================================================================
    // AFFICHAGE (JSX) : la carte d'abord, puis les panneaux par-dessus
    // ===========================================================================
    <div className={`app ${picking ? 'picking' : ''}`}>
      {/* ---------------- Carte (Leaflet) ---------------- */}
      <MapContainer
        ref={setMap}
        center={[startView.latitude, startView.longitude]}
        zoom={startView.zoom}
        minZoom={3}
        maxZoom={19}
        zoomControl={false}
        attributionControl
        className="map"
      >
        {/* Fond de carte OpenStreetMap + écouteur des déplacements / clics */}
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
        <MapEvents onViewportChange={setViewport} onMapClick={handleMapClick} onSetHome={setManualHome} />

        {/* « Autour de moi » : zone hors de portée en rouge + contour de la zone atteignable */}
        {nearData && !navigating && (
          <>
            <GeoJSON
              key={`mask-${reachKey}`}
              data={nearData.desert_mask}
              interactive={false}
              style={{ className: 'desert-area', stroke: false, fillColor: DESERT_COLOR, fillOpacity: 0.2 }}
            />
            <GeoJSON
              key={`reach-${reachKey}`}
              data={nearData.reachable_area}
              interactive={false}
              style={{
                className: 'reach-ring',
                color: '#6366f1',
                weight: 2.5,
                fill: false,
                dashArray: streetsReady ? null : '7 7',
              }}
            />
          </>
        )}

        {/* En attendant la première réponse : simple cercle */}
        {nearMode && !nearData && (
          <>
            <Polygon
              key={`mask-${userLocation.latitude}-${userLocation.longitude}-${reachRadius}`}
              positions={[WORLD_RING, circleRing(userLocation.latitude, userLocation.longitude, reachRadius)]}
              interactive={false}
              pathOptions={{
                className: 'desert-area',
                stroke: false,
                fillColor: DESERT_COLOR,
                fillOpacity: 0.2,
              }}
            />
            <Circle
              key={`reach-${userLocation.latitude}-${userLocation.longitude}-${reachRadius}`}
              center={[userLocation.latitude, userLocation.longitude]}
              radius={reachRadius}
              interactive={false}
              pathOptions={{ className: 'reach-ring', color: '#6366f1', weight: 2.5, fill: false, dashArray: '7 7' }}
            />
          </>
        )}

        {/* Analyse H3 : hexagones colorés par temps d'accès, opacité selon la population */}
        {analysisShown && !navigating && (
          <GeoJSON
            key={`hex-${hexKey}-${analysisData.summary?.cells}-${hexFeatures[0]?.properties.h3}-${analysisData.population_status}-${analysisData.summary?.population_total}`}
            data={analysisData.hexagons}
            style={(feature) => hexStyle(feature, hexKey, maxHexPopulation)}
            onEachFeature={(feature, layer) =>
              layer.bindTooltip(hexTooltip(feature.properties, STAT_CATEGORIES), {
                sticky: true,
                direction: 'top',
                className: 'hex-tooltip',
              })
            }
          />
        )}

        {/* « Toute la zone » : déserts en rouge (cachés quand les hexagones sont affichés) */}
        {!nearMode && !navigating && !showPopulation && data?.deserts?.features?.length > 0 && (
          <GeoJSON
            key={JSON.stringify(data.viewport) + category + data.stats.walk_minutes + data.stats.total_amenities}
            data={data.deserts}
            style={{
              className: 'desert-area',
              color: DESERT_COLOR,
              fillColor: DESERT_COLOR,
              fillOpacity: 0.16,
              weight: 1.4,
              dashArray: '5 6',
            }}
          />
        )}

        {/* Ligne pointillée vers le lieu choisi tant que le vrai trajet n'est pas arrivé */}
        {nearMode && selected && !streetsReady && !currentTrip && (
          <Polyline
            positions={[
              [userLocation.latitude, userLocation.longitude],
              [selected.geometry.coordinates[1], selected.geometry.coordinates[0]],
            ]}
            interactive={false}
            pathOptions={{ color: CATEGORY_COLORS[selected.properties.category], weight: 3, dashArray: '2 8', lineCap: 'round' }}
          />
        )}

        {/* Couche « Bus et tram » : voies de tram puis arrêts */}
        {transitShown &&
          transitData.tram_lines.map((line, index) => (
            <Polyline
              key={`tram-${line[0][0]}-${line[0][1]}-${line.length}-${index}`}
              positions={line}
              interactive={false}
              pathOptions={{ className: 'tram-line', color: TRAM_COLOR, weight: 4, opacity: 0.75, lineCap: 'round' }}
            />
          ))}
        {transitShown &&
          transitData.stops.map((stop) => (
            <CircleMarker
              key={`stop-${stop.id}`}
              center={[stop.lat, stop.lon]}
              radius={stop.kind === 'tram' ? 6 : 4}
              pathOptions={{
                className: 'transit-stop',
                color: '#fff',
                weight: 2,
                fillColor: stop.kind === 'tram' ? TRAM_COLOR : BUS_COLOR,
                fillOpacity: 1,
              }}
            >
              <Tooltip direction="top" offset={[0, -6]}>
                <strong>{stop.name}</strong>
                {stop.lines.length > 0 && <span className="tooltip-lines"> · {stop.lines.join(', ')}</span>}
              </Tooltip>
            </CircleMarker>
          ))}

        {/* Trajet vers le lieu choisi */}
        {activeTrip && (
          <>
            <Polyline
              key={`casing-${tripMode}-${currentTrip.key}`}
              positions={toLatLngs(activeTrip.geometry.coordinates)}
              interactive={false}
              pathOptions={{ className: 'route-casing', color: '#ffffff', weight: 9, opacity: 0.85, lineCap: 'round' }}
            />
            <Polyline
              key={`route-${tripMode}-${currentTrip.key}`}
              positions={toLatLngs(activeTrip.geometry.coordinates)}
              interactive={false}
              pathOptions={{
                className: activeTrip.method === 'estimate' ? 'route-estimate' : 'route-line',
                color: TRIP_MODES[tripMode].color,
                weight: 5,
                lineCap: 'round',
                dashArray: activeTrip.method === 'estimate' ? '8 10' : null,
              }}
            />
          </>
        )}
        {/* Itinéraire bus/tram choisi : lignes en couleur, marche en pointillés */}
        {transitSegments.map((segment, index) => (
          <Polyline
            key={`${tripMode}-${tripKey}-${index}`}
            positions={segment.positions}
            interactive={false}
            pathOptions={
              segment.type === 'ride'
                ? { className: 'route-line', color: segment.color, weight: 6, lineCap: 'round' }
                : { color: segment.color, weight: 4, dashArray: '2 9', lineCap: 'round' }
            }
          />
        ))}

        {/* Points des lieux (pharmacies, santé, alimentation) ; clic = ouvrir la fiche */}
        {shownPlaces.map((feature) => {
          const [longitude, latitude] = feature.geometry.coordinates;
          const isSelected = selected?.properties.id === feature.properties.id;
          // Fermé en ce moment, ou hors de l'itinéraire confirmé : point estompé
          const faded = !isSelected && (navigating || hoursById.get(feature.properties.id)?.state === 'closed');
          return (
            <CircleMarker
              key={feature.properties.id}
              center={[latitude, longitude]}
              radius={isSelected ? 10 : 6.5}
              pathOptions={{
                className: 'amenity-marker',
                color: '#fff',
                weight: isSelected ? 3 : 2,
                opacity: faded ? 0.45 : 1,
                fillColor: CATEGORY_COLORS[feature.properties.category] ?? '#64748b',
                fillOpacity: faded ? 0.3 : 1,
              }}
              eventHandlers={{
                click: (event) => {
                  // Empêche le clic d'atteindre la carte (qui fermerait la fiche)
                  L.DomEvent.stopPropagation(event);
                  setSelected(feature);
                },
              }}
            />
          );
        })}

        {/* Ma position : cercle de précision du GPS puis point bleu */}
        {userLocation?.source === 'gps' && userLocation.accuracy > 30 && (
          <Circle
            center={[userLocation.latitude, userLocation.longitude]}
            radius={userLocation.accuracy}
            interactive={false}
            pathOptions={{ className: 'accuracy-circle', weight: 1, fillOpacity: 0.08 }}
          />
        )}
        {userLocation && (
          <Marker
            key={`${userLocation.latitude}-${userLocation.longitude}`}
            position={[userLocation.latitude, userLocation.longitude]}
            icon={userIcon}
            interactive={false}
          />
        )}
      </MapContainer>

      {/* Barre de progression en haut de l'écran */}
      <div
        className={`progress ${loading || data?.osm_status === 'loading' || data?.streets_status === 'loading' ? 'active' : ''}`}
      />

      {/* ---------------- Panneau principal ---------------- */}
      <aside className={`panel ${sheetOpen ? 'open' : 'collapsed'}`}>
        <button
          type="button"
          className="sheet-handle"
          aria-label={sheetOpen ? 'Réduire le panneau' : 'Afficher le panneau'}
          onClick={() => setSheetOpen((open) => !open)}
        >
          <span />
          <ChevronUp size={16} />
        </button>

        {/* En-tête : logo, bouton « Comment ça marche » et thème clair/sombre */}
        <header className="panel-header">
          <div className="brand">
            <span className="brand-mark">
              <Footprints size={19} strokeWidth={2.4} />
            </span>
            <div>
              <strong>
                care<span>map</span>
              </strong>
              <small>Observatoire de la ville à 15 min</small>
            </div>
          </div>
          <div className="header-actions">
            {/* Mon compte : connexion / inscription, ou le compte connecté (point vert) */}
            <button
              type="button"
              className={`icon-button account-button ${account ? 'signed-in' : ''}`}
              aria-label={account ? `Mon compte (${account.email})` : 'Se connecter'}
              title={account ? `Connecté : ${account.display_name || account.email}` : 'Se connecter / créer un compte'}
              onClick={() => setAccountModal('citizen')}
            >
              <UserRound size={18} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Comment ça marche"
              title="Comment ça marche"
              onClick={() => setShowIntro(true)}
            >
              <Info size={18} />
            </button>
            <button
              type="button"
              className="icon-button theme-toggle"
              aria-label="Changer de thème"
              title="Changer de thème"
              onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
            >
              <span key={theme} className="theme-icon">
                {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
              </span>
            </button>
          </div>
        </header>

        <div className="panel-body">
          {/* Barre de recherche : choisir un résultat déplace la carte */}
          <SearchBox onSelect={(place) => goTo(place.latitude, place.longitude, 15)} />

          {/* Carte « Ma position » : clic = recentrer ; boutons GPS et « Sur la carte » */}
          <section className={`location-card source-${userLocation?.source ?? 'none'}`}>
            <button
              type="button"
              className="location-main"
              title="Recentrer la carte sur ma position"
              disabled={!userLocation}
              onClick={() => {
                if (!userLocation) return;
                if (nearMode) fitReach();
                else goTo(userLocation.latitude, userLocation.longitude, 16);
              }}
            >
              <span className="location-icon">
                <MapPin size={18} />
              </span>
              <span className="location-text">
                <span className="kicker">Ma position</span>
                <strong>{userLocation?.label ?? (askLocation ? 'Non définie' : '…')}</strong>
                <small>
                  {userLocation || !askLocation
                    ? describeSource(userLocation)
                    : 'Cherchez votre quartier ou cliquez sur « Sur la carte »'}
                </small>
              </span>
            </button>
            <div className="location-actions">
              <button type="button" className="chip-button" onClick={locateWithGps} disabled={locating}>
                <LocateFixed size={15} className={locating ? 'spin' : ''} />
                {locating ? 'Recherche…' : 'GPS'}
              </button>
              <button
                type="button"
                className={`chip-button ${picking ? 'active' : ''}`}
                aria-pressed={picking}
                onClick={() => setPicking((current) => !current)}
              >
                <Crosshair size={15} />
                Sur la carte
              </button>
              {/* Mode confidentiel : position arrondie à ~500 m et jamais enregistrée */}
              <button
                type="button"
                className={`chip-button privacy-chip ${privacy ? 'active' : ''}`}
                aria-pressed={privacy}
                title="Position arrondie à ~500 m, jamais enregistrée, ni GPS ni IP automatiques"
                onClick={() => setPrivacy((current) => !current)}
              >
                <ShieldCheck size={15} />
                Confidentiel
              </button>
            </div>
          </section>

          {/* Choix du mode : « Autour de moi » ou « Toute la zone » */}
          <div className="mode-switch" role="group" aria-label="Type d'analyse" data-mode={mode}>
            <span className="mode-pill" />
            <button
              type="button"
              className={mode === 'me' ? 'active' : ''}
              aria-pressed={mode === 'me'}
              onClick={() => setMode('me')}
            >
              <Navigation size={15} />
              Autour de moi
            </button>
            <button
              type="button"
              className={mode === 'city' ? 'active' : ''}
              aria-pressed={mode === 'city'}
              onClick={() => setMode('city')}
            >
              <Layers size={15} />
              Toute la zone
            </button>
          </div>

          {/* Résumé : verdict « Autour de moi » (une ligne par catégorie) ou jauge de couverture */}
          {nearMode ? (
            <section className={`reach-card tone-${reachTone}`}>
              <span className="kicker">À {debouncedMinutes} min à pied de vous</span>
              <strong className="reach-verdict">
                {reachTone === 'busy'
                  ? 'Recherche des services…'
                  : reachTone === 'good'
                    ? 'Tout est accessible à pied'
                    : 'Désert de services'}
              </strong>
              <small className="reach-summary">
                {reachTone === 'busy'
                  ? 'Téléchargement des lieux autour de vous depuis OpenStreetMap.'
                  : reachTone === 'good'
                    ? `${reach.places.length} lieu${reach.places.length > 1 ? 'x' : ''} à moins de ${debouncedMinutes} min. Au-delà du cercle : désert.`
                    : `Aucun service « ${missing.map((item) => item.label.toLowerCase()).join(' », « ')} » à moins de ${debouncedMinutes} min.`}
              </small>
              <div className="reach-cats">
                {checkedCategories.map((item) => {
                  const list = reach?.byCategory[item.id] ?? [];
                  const nearest = list[0];
                  return (
                    <div className="reach-cat" key={item.id} style={{ '--color': item.color }}>
                      <span className="reach-cat-icon">
                        <item.icon size={16} />
                      </span>
                      <span className="reach-cat-text">
                        <strong>
                          {item.label} <em>{list.length}</em>
                        </strong>
                        <small>
                          {nearest
                            ? `La plus proche : ${formatMinutes(nearest.minutes)} (${formatDistance(nearest.distance)})`
                            : `Aucune à moins de ${debouncedMinutes} min`}
                        </small>
                      </span>
                      <span className={`reach-badge ${nearest ? 'ok' : 'ko'}`}>
                        {nearest ? <Check size={14} strokeWidth={3} /> : <X size={14} strokeWidth={3} />}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : (
            <CoverageGauge coverage={coverage} minutes={stats?.walk_minutes ?? minutes} pending={pending} />
          )}

          {/* Curseur du temps de marche (seulement en « Autour de moi ») */}
          <section className={`block ${mode === 'me' ? '' : 'hidden'}`}>
            <div className="block-title">
              <h3>Temps de marche</h3>
              <span className="walk-value">
                <strong>{minutes} min</strong> · {formatDistance(minutes * WALK_SPEED_M_PER_MIN)}
              </span>
            </div>
            <input
              type="range"
              className="slider"
              min={WALK_MINUTES.min}
              max={WALK_MINUTES.max}
              step={WALK_MINUTES.step}
              value={minutes}
              style={{ '--pct': `${sliderPct}%` }}
              onChange={(event) => setMinutes(Number(event.target.value))}
              aria-label="Temps de marche maximal en minutes"
            />
            <div className="slider-ticks">
              {[5, 10, 15, 20, 25, 30].map((value) => (
                <span key={value} className={value === minutes ? 'active' : ''}>
                  {value}
                </span>
              ))}
            </div>
          </section>

          <section className="block">
            <div className="block-title">
              {/* Filtre de catégorie (la pastille colorée glisse sous le bouton actif) */}
              <h3>Services analysés</h3>
            </div>
            <div className="segmented" role="group" aria-label="Filtrer par catégorie" style={{ '--index': categoryIndex }}>
              <span className="segmented-pill" style={{ '--color': CATEGORIES[categoryIndex].color }} />
              {CATEGORIES.map(({ id, label, icon: Icon }) => (
                <button
                  type="button"
                  key={id}
                  className={category === id ? 'active' : ''}
                  aria-pressed={category === id}
                  onClick={() => setCategory(id)}
                >
                  <Icon size={17} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          </section>

          {/* Interrupteur de la couche « Bus et tram » */}
          {!nearMode && (
            <section className="block">
              <button
                type="button"
                className={`transit-toggle ${showTransit ? 'on' : ''}`}
                aria-pressed={showTransit}
                onClick={() => setShowTransit((current) => !current)}
              >
                <span className="transit-toggle-icon">
                  <TramFront size={17} />
                </span>
                <span className="transit-toggle-text">
                  <strong>Bus et tram</strong>
                  <small>{transitText}</small>
                </span>
                <span className="switch" aria-hidden="true">
                  <span />
                </span>
              </button>
            </section>
          )}

          {/* Espace pro : sans compte pro, une invitation à se connecter */}
          {!nearMode && !isPro && (
            <section className="block">
              <button type="button" className="transit-toggle pro-invite" onClick={() => setAccountModal('pro')}>
                <span className="transit-toggle-icon">
                  <Hexagon size={17} />
                </span>
                <span className="transit-toggle-text">
                  <strong>Espace pro</strong>
                  <small>Population et zones où s’installer · compte pro requis</small>
                </span>
              </button>
            </section>
          )}

          {/* Interrupteur de la couche « Population (H3) » (comptes pro seulement) */}
          {!nearMode && isPro && (
            <section className="block">
              <button
                type="button"
                className={`transit-toggle population-toggle ${showPopulation ? 'on' : ''}`}
                aria-pressed={showPopulation}
                onClick={() => setShowPopulation((current) => !current)}
              >
                <span className="transit-toggle-icon">
                  <Hexagon size={17} />
                </span>
                <span className="transit-toggle-text">
                  <strong>Population (H3)</strong>
                  <small>{populationText}</small>
                </span>
                <span className="switch" aria-hidden="true">
                  <span />
                </span>
              </button>
            </section>
          )}

          {/* Résultats de l'analyse H3 (voir components/PopulationCard.jsx) */}
          {analysisShown && (
            <PopulationCard
              data={analysisData}
              category={category}
              categories={STAT_CATEGORIES}
              onFocus={(latitude, longitude) => goTo(latitude, longitude, 16)}
            />
          )}

          {/* Liste des lieux les plus proches (8 premiers), clic = ouvrir la fiche */}
          {nearMode && reach && (
            <section className="block">
              <div className="block-title">
                <h3>Les plus proches</h3>
                <span className="muted">{reach.places.length} lieux</span>
              </div>
              {reach.places.length === 0 ? (
                <p className="muted reach-empty">Rien à moins de {debouncedMinutes} min : essayez un temps plus long.</p>
              ) : (
                <ul className="reach-list">
                  {reach.places.slice(0, 8).map((place) => (
                    <li key={place.feature.properties.id}>
                      <button
                        type="button"
                        className={selected?.properties.id === place.feature.properties.id ? 'active' : ''}
                        style={{ '--color': CATEGORY_COLORS[place.feature.properties.category] }}
                        onClick={() => setSelected(place.feature)}
                      >
                        <span className="reach-dot" />
                        <span className="reach-name">
                          <strong>{place.feature.properties.name}</strong>
                          <small>{place.feature.properties.category_label}</small>
                        </span>
                        <span className="reach-time">
                          <strong>{formatMinutes(place.minutes)}</strong>
                          <small>{formatDistance(place.distance)}</small>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="reach-note">
                {streetsReady
                  ? 'Temps calculés le long des rues et chemins piétons (OpenStreetMap), à 4,5 km/h.'
                  : nearData?.streets_status === 'loading'
                    ? 'Estimation provisoire à vol d’oiseau (+30 % de détour) : le plan des rues est en cours de téléchargement.'
                    : 'Plan des rues indisponible : estimation à vol d’oiseau (+30 % de détour).'}
              </p>
            </section>
          )}

          {/* Nombre de lieux par catégorie dans la vue (« Toute la zone ») */}
          <section className={`block ${nearMode ? 'hidden' : ''}`}>
            <div className="block-title">
              <h3>Dans la zone visible</h3>
              <span className="muted">{stats?.total_amenities ?? 0} lieux</span>
            </div>
            {statCategories.map((item) => (
              <StatRow key={item.id} category={item} count={counts[item.id]} max={maxCount} />
            ))}
          </section>

          {/* Légende du rouge */}
          <footer className="panel-footer">
            <span className="legend-swatch" />
            {nearMode
              ? `En rouge : à plus de ${debouncedMinutes} min à pied de vous`
              : `Zone à plus de ${stats?.walk_minutes ?? minutes} min d’un service`}
          </footer>
        </div>
      </aside>

      {/* ---------------- Contrôles de la carte ---------------- */}
      <div className={`status-chip tone-${statusInfo.tone}`} key={statusInfo.label}>
        <span className="status-dot" />
        {statusInfo.label}
      </div>

      {/* Boutons zoom +, zoom - et GPS en bas à droite */}
      <div className="map-controls">
        <button type="button" className="icon-button" aria-label="Zoomer" onClick={() => map?.zoomIn()}>
          <Plus size={18} />
        </button>
        <button type="button" className="icon-button" aria-label="Dézoomer" onClick={() => map?.zoomOut()}>
          <Minus size={18} />
        </button>
        <button
          type="button"
          className="icon-button locate"
          aria-label="Me localiser"
          title="Me localiser (GPS)"
          onClick={locateWithGps}
          disabled={locating}
        >
          <LocateFixed size={18} className={locating ? 'spin' : ''} />
        </button>
      </div>

      {/* ---------------- Fiche du lieu sélectionné ---------------- */}
      {selected && (
        <div
          className="place-card"
          key={selected.properties.id}
          style={{ '--color': CATEGORY_COLORS[selected.properties.category] }}
        >
          {/* En-tête de la fiche : icône, catégorie, nom, adresse, ouvert/fermé */}
          <span className="place-icon">
            <MapPin size={18} />
          </span>
          <div className="place-text">
            <span className="kicker">{selected.properties.category_label}</span>
            <strong>{selected.properties.name}</strong>
            {selected.properties.address && <small>{selected.properties.address}</small>}
            <span className={`hours-badge ${selectedHours.state}`}>
              <Clock size={12} />
              {selectedHours.text}
            </span>
            {/* Vue « Y aller » : résumé du trajet confirmé, mini-carte, boutons Modifier / Google Maps */}
            {navigating && goChoice && (
              <div className="nav" style={{ '--color': goChoice.color }}>
                <div className="nav-summary">
                  <span className="nav-mode">
                    <goChoice.icon size={18} />
                  </span>
                  <span className="nav-figures">
                    <strong>
                      {goChoice.label} · {activeTransit || activeTrip?.method === 'estimate' ? '≈ ' : ''}
                      {formatDuration(goChoice.minutes)}
                    </strong>
                    <small>
                      {goChoice.distance ? `${formatDistance(goChoice.distance)} · ` : ''}arrivée vers {arrival}
                    </small>
                  </span>
                </div>
                <MiniRouteMap
                  key={`${tripKey}-${tripMode}`}
                  segments={goChoice.segments}
                  from={[tripQuery.from_lat, tripQuery.from_lon]}
                  to={[tripQuery.to_lat, tripQuery.to_lon]}
                  endColor={CATEGORY_COLORS[selected.properties.category]}
                />
                {goChoice.note && <small className="trip-note">{goChoice.note}</small>}
                <div className="nav-actions">
                  <button type="button" className="chip-button" onClick={() => setNavigating(false)}>
                    <ArrowLeft size={15} />
                    Modifier
                  </button>
                  <a
                    className="chip-button"
                    href={googleMapsUrl(
                      [tripQuery.from_lat, tripQuery.from_lon],
                      [tripQuery.to_lat, tripQuery.to_lon],
                      activeTransit ? 'transit' : tripMode
                    )}
                    target="_blank"
                    rel="noreferrer"
                  >
                    <ExternalLink size={15} />
                    Google Maps
                  </a>
                </div>
              </div>
            )}
            {/* Vue normale : temps de trajet par mode, puis itinéraires bus/tram, puis bouton « Y aller » */}
            {!navigating && (
              <div className="trip">
                {!userLocation ? (
                  <small className="trip-note">Indiquez votre position pour voir le temps de trajet.</small>
                ) : !currentTrip ? (
                  <small className="trip-loading">
                    <span className="trip-spinner" /> Calcul des itinéraires depuis votre position…
                  </small>
                ) : currentTrip.error ? (
                  <small className="trip-note">Itinéraires indisponibles pour le moment.</small>
                ) : (
                  <>
                    <span className="kicker trip-kicker">Depuis votre position</span>
                    <ul className="trip-list">
                      {/* Une ligne par mode (à pied, vélo, moto, voiture) ; clic = afficher ce trajet sur la carte */}
                      {currentTrip.trips.map((item) => {
                        const config = TRIP_MODES[item.mode];
                        return (
                          <li key={item.mode}>
                            <button
                              type="button"
                              className={tripMode === item.mode ? 'active' : ''}
                              style={{ '--color': config.color }}
                              onClick={() => setTripMode(item.mode)}
                            >
                              <config.icon size={16} />
                              <span className="trip-label">{config.label}</span>
                              <span className="trip-distance">{formatDistance(item.distance_m)}</span>
                              <strong>
                                {item.method === 'estimate' ? '≈ ' : ''}
                                {formatDuration(item.duration_min)}
                              </strong>
                            </button>
                          </li>
                        );
                      })}
                    </ul>

                    <span className="kicker trip-kicker trip-sub">Bus et tram · du plus rapide au plus lent</span>
                    {/* Itinéraires bus/tram (déjà triés du plus rapide au plus lent), sinon un message explicatif */}
                    {transitOptions.length > 0 ? (
                      <ul className="trip-list">
                        {transitOptions.map((option, index) => {
                          const rides = option.legs.filter((leg) => leg.type === 'ride');
                          return (
                            <li key={rides.map((ride) => ride.line).join('>')}>
                              <button
                                type="button"
                                className={`trip-transit ${tripMode === `t${index}` ? 'active' : ''}`}
                                style={{ '--color': rideColor(rides[0]) }}
                                onClick={() => setTripMode(`t${index}`)}
                              >
                                <span className="trip-rides">
                                  {rides.map((ride, k) => (
                                    <span
                                      key={`${ride.line}-${k}`}
                                      className="ride-chip"
                                      style={{ '--color': rideColor(ride) }}
                                    >
                                      {ride.mode === 'tram' ? <TramFront size={13} /> : <Bus size={13} />}
                                      {ride.line}
                                    </span>
                                  ))}
                                </span>
                                <span className="trip-distance">
                                  {formatMinutes(option.walk_min)} à pied
                                  {option.transfers > 0 ? ` · ${option.transfers} corresp.` : ''}
                                </span>
                                <strong>≈ {formatDuration(option.total_min)}</strong>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <small className={transitInfo?.status === 'loading' ? 'trip-loading' : 'trip-note'}>
                        {transitInfo?.status === 'loading' && <span className="trip-spinner" />}
                        {transitInfo?.status === 'loading'
                          ? 'Recherche des lignes de bus et de tram…'
                          : transitInfo?.status === 'too_far'
                            ? 'Trop loin pour les lignes de ville.'
                            : transitInfo?.status === 'unavailable'
                              ? 'Données bus et tram indisponibles, nouvel essai bientôt.'
                              : transitInfo?.nearest_stop
                                ? `Aucun trajet en bus ou tram plus rapide qu’à pied. Arrêt le plus proche : « ${transitInfo.nearest_stop.name} », à ${formatMinutes(transitInfo.nearest_stop.walk_min)}.`
                                : 'Aucun arrêt de bus ou de tram connu près de vous.'}
                      </small>
                    )}

                    <small className="trip-note">{tripNote(tripMode, activeTrip, activeTransit)}</small>
                    {/* Bouton « Y aller » : confirme le mode choisi et affiche la mini-carte */}
                    {goChoice && (
                      <button
                        type="button"
                        className="go-button"
                        style={{ '--color': goChoice.color }}
                        onClick={() => setNavigating(true)}
                      >
                        <Check size={16} strokeWidth={3} />
                        <span>Y aller</span>
                        <span className="go-detail">
                          {goChoice.label} · {formatDuration(goChoice.minutes)}
                        </span>
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
          <button type="button" className="icon-button" aria-label="Fermer" onClick={() => setSelected(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Fenêtre « Où êtes-vous ? » quand le navigateur ne donne pas de position */}
      {askLocation && !userLocation && !picking && (
        <div className="ask-card" role="dialog" aria-labelledby="ask-title">
          <button
            type="button"
            className="icon-button ask-close"
            aria-label="Plus tard"
            onClick={() => setAskLocation(false)}
          >
            <X size={16} />
          </button>
          <span className="ask-icon">
            <MapPin size={20} />
          </span>
          <h2 id="ask-title">Où êtes-vous ?</h2>
          <p>
            {privacy
              ? 'Mode confidentiel : indiquez un quartier ou un point proche. La position est arrondie à ~500 m et n’est jamais enregistrée.'
              : 'Votre appareil ne donne pas sa position. Indiquez-la une fois : elle sera mémorisée pour vos prochaines visites.'}
          </p>
          <SearchBox onSelect={(place) => setManualHome(place.latitude, place.longitude, place.name)} />
          <div className="ask-actions">
            <button type="button" className="chip-button" onClick={() => setPicking(true)}>
              <Crosshair size={15} />
              Cliquer sur la carte
            </button>
            <button type="button" className="chip-button" onClick={locateWithGps} disabled={locating}>
              <LocateFixed size={15} className={locating ? 'spin' : ''} />
              {locating ? 'Recherche…' : 'Réessayer le GPS'}
            </button>
          </div>
          {locationError && <small className="ask-error">{locationError}</small>}
        </div>
      )}

      {/* Bandeau affiché pendant le choix de la position sur la carte */}
      {picking && (
        <div className="pick-banner" role="status">
          <Crosshair size={17} />
          <span>Cliquez sur la carte à l’endroit où vous êtes</span>
          <button type="button" className="icon-button" aria-label="Annuler" onClick={() => setPicking(false)}>
            <X size={16} />
          </button>
        </div>
      )}

      {/* Messages d'erreur (backend injoignable, position indisponible) */}
      {apiError && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <div>
            <strong>Backend injoignable</strong>
            <span>{apiError}</span>
          </div>
          <button type="button" className="toast-action" onClick={() => setRefreshTick((tick) => tick + 1)}>
            Réessayer
          </button>
        </div>
      )}

      {!apiError && locationError && !picking && !(askLocation && !userLocation) && (
        <div className="toast toast-info" role="alert">
          <MapPin size={18} />
          <div>
            <strong>Position précise indisponible</strong>
            <span>{locationError}</span>
          </div>
          <div className="toast-buttons">
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                setLocationError('');
                setPicking(true);
              }}
            >
              Sur la carte
            </button>
            <button type="button" className="icon-button" aria-label="Fermer" onClick={() => setLocationError('')}>
              <X size={15} />
            </button>
          </div>
        </div>
      )}

      {/* Fenêtre « Comment ça marche » */}
      {showIntro && <HowItWorks onClose={closeIntro} />}

      {/* Fenêtre « Mon compte » (voir components/AccountModal.jsx) */}
      {accountModal && (
        <AccountModal
          account={account}
          initialRole={accountModal}
          onClose={() => setAccountModal(null)}
          onSignedIn={signIn}
          onSignOut={signOut}
        />
      )}
    </div>
  );
}
