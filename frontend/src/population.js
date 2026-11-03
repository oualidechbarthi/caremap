/**
 * Couche « Population (H3) » : couleurs et infobulles des hexagones.
 * Chaque hexagone est coloré selon le temps de marche vers les services,
 * et son opacité suit sa population (une zone vide reste presque transparente).
 */

// Paliers de temps de marche (minutes) et leur couleur, du vert au rouge
export const ACCESS_STEPS = [
  { max: 5, color: '#10b981', label: '≤ 5' },
  { max: 10, color: '#84cc16', label: '5–10' },
  { max: 15, color: '#eab308', label: '10–15' },
  { max: 20, color: '#f97316', label: '15–20' },
  { max: Infinity, color: '#ef4444', label: '> 20' },
];

// Minutes -> couleur du palier correspondant (rouge si aucun service trouvé)
export function accessColor(minutes) {
  if (minutes === null || minutes === undefined) return ACCESS_STEPS.at(-1).color;
  return ACCESS_STEPS.find((step) => minutes <= step.max).color;
}

/** Temps affiché selon le filtre : les 3 services (« Tous ») ou une seule catégorie. */
export const metricKey = (category) => (category === 'all' ? 't_all' : `t_${category}`);

// 12345.6 -> « 12 346 » (format français, espace entre les milliers)
export const formatPeople = (value) => Math.round(value ?? 0).toLocaleString('fr-FR');

export function formatMinutesShort(value) {
  if (value === null || value === undefined) return '> 30 min';
  return value < 1 ? '< 1 min' : `${Math.round(value)} min`;
}

/** Style Leaflet d'un hexagone. */
export function hexStyle(feature, key, maxPopulation) {
  const { population } = feature.properties;
  const minutes = feature.properties[key];
  // Sans données de population : opacité moyenne uniforme
  // weight = population de l'hexagone par rapport au plus peuplé de la vue (de 0 à 1)
  const weight = population === null ? 0.5 : Math.min(1, population / Math.max(maxPopulation, 1));
  return {
    className: 'hex-cell',
    color: accessColor(minutes),
    weight: 0.6,
    opacity: 0.5,
    fillColor: accessColor(minutes),
    // Racine carrée : les hexagones peu peuplés restent visibles sans écraser les autres
    fillOpacity: population === null ? 0.4 : 0.08 + 0.6 * Math.sqrt(weight),
  };
}

/** Infobulle d'un hexagone (texte construit uniquement à partir de nombres et de libellés fixes). */
export function hexTooltip(properties, categories) {
  const rows = categories
    .map(
      (item) =>
        `<span class="hex-tip-row"><i style="background:${item.color}"></i>${item.label}<b>${formatMinutesShort(
          properties[`t_${item.id}`]
        )}</b></span>`
    )
    .join('');
  const people =
    properties.population === null ? '' : `<strong>${formatPeople(properties.population)} habitants</strong>`;
  return `<div class="hex-tip">${people}${rows}</div>`;
}
