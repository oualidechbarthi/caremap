import { useAnimatedNumber } from '../hooks.js';

// Rayon du cercle SVG et sa circonférence (longueur du trait quand l'anneau est plein)
const RADIUS = 52;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// Couleur et titre selon le pourcentage : vert ≥ 85 %, orange ≥ 60 %, rouge sinon
function toneFor(coverage) {
  if (coverage >= 85) return { id: 'good', label: 'Quartier très bien desservi' };
  if (coverage >= 60) return { id: 'warning', label: 'Desserte partielle' };
  return { id: 'critical', label: 'Désert de services' };
}

/** Anneau animé : part de la zone visible à moins de N minutes d'un service. */
export default function CoverageGauge({ coverage, minutes, pending }) {
  // pending = vue trop large ou données pas encore prêtes : l'anneau reste vide
  const shown = pending ? 0 : coverage;
  const animated = useAnimatedNumber(shown);
  const tone = toneFor(coverage);

  return (
    <section className={`gauge-card tone-${pending ? 'muted' : tone.id}`}>
      <div className="gauge">
        <svg viewBox="0 0 120 120" aria-hidden="true">
          <circle className="gauge-track" cx="60" cy="60" r={RADIUS} />
          <circle
            className="gauge-value"
            cx="60"
            cy="60"
            r={RADIUS}
            strokeDasharray={CIRCUMFERENCE}
            // Astuce SVG : le décalage du trait détermine la part de l'anneau qui est remplie
            strokeDashoffset={CIRCUMFERENCE * (1 - shown / 100)}
          />
        </svg>
        <div className="gauge-label">
          <strong>{pending ? '—' : Math.round(animated)}</strong>
          {!pending && <span>%</span>}
        </div>
      </div>
      <div className="gauge-text">
        <span className="kicker">Couverture piétonne</span>
        <h2 key={pending ? 'pending' : tone.id} className="fade-swap">
          {pending ? 'Analyse en attente' : tone.label}
        </h2>
        <p>
          {pending
            ? 'Zoomez sur un quartier pour lancer l’analyse.'
            : `de la zone visible a un service à moins de ${minutes} min à pied.`}
        </p>
      </div>
    </section>
  );
}
