import { MapPin, Users } from 'lucide-react';
import { useAnimatedNumber } from '../hooks.js';
import { ACCESS_STEPS, formatMinutesShort, formatPeople } from '../population.js';

/**
 * Synthèse de l'analyse H3 : combien d'habitants vivent trop loin des services,
 * détail par catégorie, légende des couleurs et zones prioritaires.
 */
export default function PopulationCard({ data, category, categories, onFocus }) {
  // data = réponse de /api/analysis ; known = les données d'habitants sont-elles disponibles ?
  const summary = data?.summary;
  const known = Boolean(summary?.population_known);
  const checked = category === 'all' ? categories : categories.filter((item) => item.id === category);

  // Habitants trop loin : des 3 services (« Tous ») ou de la catégorie filtrée
  const outside = !summary
    ? 0
    : category === 'all'
      ? summary.population_desert
      : summary.population_beyond?.[category];
  // Le grand nombre « défile » quand il change ; share = pourcentage de la population
  const animated = useAnimatedNumber(known ? outside ?? 0 : 0);
  const share = known && summary.population_total ? Math.round(((outside ?? 0) / summary.population_total) * 100) : 0;
  const what = category === 'all' ? 'd’au moins un des 3 services' : `de : ${checked[0]?.label.toLowerCase()}`;

  // Rien à afficher tant que l'analyse n'est pas arrivée
  if (!summary) return null;

  return (
    <section className="block population-card">
      {known ? (
        <>
          <span className="kicker">Population de la zone visible</span>
          <div className="population-headline">
            <span className="population-icon">
              <Users size={18} />
            </span>
            <span>
              <strong>{formatPeople(animated)}</strong> habitants
              <small>
                soit {share} % des {formatPeople(summary.population_total)} habitants vivent à plus de{' '}
                {summary.minutes} min à pied {what}
              </small>
            </span>
          </div>

          {/* Avec « Tous » : une barre par catégorie (longueur = part des habitants trop loin) */}
          {category === 'all' && (
            <div className="population-cats">
              {categories.map((item) => {
                const count = summary.population_beyond[item.id];
                const ratio = summary.population_total ? count / summary.population_total : 0;
                return (
                  <div key={item.id} className="population-cat" style={{ '--color': item.color }}>
                    <span className="population-cat-name">
                      <item.icon size={14} />
                      {item.label}
                    </span>
                    <span className="population-cat-value">{formatPeople(count)} hab. trop loin</span>
                    <span className="population-bar">
                      <span style={{ transform: `scaleX(${ratio})` }} />
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : (
        <>
          {/* Sans données d'habitants : on affiche seulement le nombre d'hexagones bien desservis */}
          <span className="kicker">Hexagones de la zone visible</span>
          <p className="population-fallback">
            <strong>
              {summary.cells_covered} / {summary.cells}
            </strong>{' '}
            hexagones ont les 3 services à moins de {summary.minutes} min.
          </p>
        </>
      )}

      {/* Légende des couleurs (minutes de marche) */}
      <div className="hex-legend" aria-label="Légende : temps de marche">
        {ACCESS_STEPS.map((step) => (
          <span key={step.label} style={{ '--color': step.color }}>
            <i />
            {step.label}
          </span>
        ))}
        <em>min à pied</em>
      </div>

      {/* Zones prioritaires : clic -> la carte zoome sur l'hexagone */}
      {known && summary.priority.length > 0 && (
        <div className="priority">
          <h4>Zones prioritaires</h4>
          <ul>
            {summary.priority.map((zone, index) => (
              <li key={zone.h3}>
                <button type="button" onClick={() => onFocus(zone.lat, zone.lon)}>
                  <span className="priority-rank">{index + 1}</span>
                  <span className="priority-text">
                    <strong>{formatPeople(zone.population)} habitants</strong>
                    <small>
                      manque :{' '}
                      {zone.missing
                        .map((id) => categories.find((item) => item.id === id)?.label.toLowerCase())
                        .join(', ')}
                    </small>
                  </span>
                  <span className="priority-time">{formatMinutesShort(zone.t_all)}</span>
                  <MapPin size={14} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="population-note">
        Hexagones H3 de ~350 m · distances à vol d’oiseau +30 % de détour
        {known ? ' · population : Kontur (CC BY 4.0), estimation répartie par hexagone' : ''}
      </p>
    </section>
  );
}
