// Fenêtre « Comment ça marche » : s'ouvre avec le bouton (i) en haut du panneau.
import { useEffect } from 'react';
import { CircleDashed, Database, Footprints, ScanSearch, X } from 'lucide-react';

// Les étapes affichées dans la fenêtre : icône, titre et texte
const STEPS = [
  {
    icon: Footprints,
    title: 'La ville du quart d’heure',
    text: 'L’idée : pharmacie, médecin et alimentation devraient être à moins de 15 minutes à pied de chez soi.',
  },
  {
    icon: Database,
    title: '1 · On récupère les services',
    text: 'Quand vous déplacez la carte, le serveur télécharge les pharmacies, lieux de santé et commerces alimentaires depuis OpenStreetMap, puis les garde en cache (SQLite).',
  },
  {
    icon: CircleDashed,
    title: '2 · « Autour de moi » : ce que vous atteignez à pied',
    text: 'Depuis votre position, on suit le plan des rues (comme un GPS piéton, à 4,5 km/h) jusqu’à épuiser votre temps de marche. Seuls les services dans cette zone sont affichés, avec leur temps de trajet ; tout le reste est en rouge.',
  },
  {
    icon: ScanSearch,
    title: '3 · « Toute la zone » : les déserts du quartier',
    text: 'Pour analyser un quartier entier, on trace un cercle de marche autour de chaque service. Ce qui reste hors de tous les cercles est un désert ; le score indique la part couverte.',
  },
];

// onClose = fonction fournie par App.jsx pour fermer la fenêtre
export default function HowItWorks({ onClose }) {
  // La touche Échap ferme la fenêtre (l'écouteur est retiré quand la fenêtre se ferme)
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    // Clic sur le fond sombre = fermer ; stopPropagation empêche un clic DANS la fenêtre de la fermer
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="how-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="icon-button modal-close" aria-label="Fermer" onClick={onClose}>
          <X size={18} />
        </button>
        <span className="kicker">Comment ça marche</span>
        <h2 id="how-title">Repérer les déserts de services en 3 étapes</h2>
        <ol className="steps">
          {STEPS.map(({ icon: Icon, title, text }, index) => (
            <li key={title} style={{ '--i': index }}>
              <span className="step-icon">
                <Icon size={19} />
              </span>
              <div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
        <p className="modal-note">
          Le plan des rues est téléchargé la première fois (jusqu’à ~30 s) ; en attendant, une estimation
          à vol d’oiseau (+30 % de détour) s’affiche. Le mode « Toute la zone » reste à vol d’oiseau.
        </p>
        <button type="button" className="primary-button" onClick={onClose}>
          Explorer la carte
        </button>
      </div>
    </div>
  );
}
