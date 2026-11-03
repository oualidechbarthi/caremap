/**
 * Lecture des horaires d'ouverture OpenStreetMap (tag « opening_hours »).
 *
 * Couvre les formes courantes : « 24/7 », « Mo-Fr 09:00-19:00; Sa 09:00-13:00 »,
 * plusieurs plages « 08:30-12:30,14:30-19:00 », les horaires de nuit « 20:00-02:00 »,
 * « Su off » et les règles sans jour (« 09:00-21:00 » = tous les jours).
 * Les formes plus rares (mois, jours fériés seuls, semaines…) donnent « inconnu »
 * plutôt qu'une réponse fausse.
 */

// Jours dans l'ordre OSM (lundi = 0) ; WEEK_MIN = nombre de minutes dans une semaine
const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY_NAMES = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];
const WEEK_MIN = 7 * 24 * 60;

// « 09:30 » -> 570 (minutes depuis minuit) ; null si le texte n'est pas une heure
function parseTime(text) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return minutes <= 24 * 60 ? minutes : null;
}

/** « Mo-Fr,Su » → [0, 1, 2, 3, 4, 6] ; null si le sélecteur n'est pas compris. */
function parseDays(selector) {
  const days = new Set();
  for (const part of selector.split(',')) {
    const [from, to] = part.split('-');
    const start = DAYS.indexOf(from);
    if (start < 0) return null;
    const end = to === undefined ? start : DAYS.indexOf(to);
    if (end < 0) return null;
    // Boucle sur les jours de start à end (« Sa-Mo » passe par dimanche)
    for (let day = start; ; day = (day + 1) % 7) {
      days.add(day);
      if (day === end) break;
    }
  }
  return [...days];
}

/** Horaires → semaine de plages [début, fin] en minutes depuis lundi 00:00 ; null si non compris. */
export function parseOpeningHours(value) {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (text === '24/7') return [[0, WEEK_MIN]];

  // Chaque règle remplace les précédentes pour les jours qu'elle cite (règle OSM)
  // week[0..6] = plages horaires de chaque jour ; les règles sont séparées par « ; »
  const week = Array.from({ length: 7 }, () => []);
  for (const raw of text.replace(/\|\|/g, ';').split(';')) {
    let rule = raw.trim();
    if (!rule) continue;
    if (/^PH\b/.test(rule) || /^SH\b/.test(rule)) continue; // jours fériés : ignorés
    rule = rule.replace(/,\s*PH\b/g, '');

    // La règle commence-t-elle par des jours (« Mo-Fr ... ») ? Sinon elle vaut pour tous les jours
    let days = [0, 1, 2, 3, 4, 5, 6];
    const daysMatch = /^((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:[-,](?:Mo|Tu|We|Th|Fr|Sa|Su))*)\s+(.*)$/.exec(rule);
    if (daysMatch) {
      days = parseDays(daysMatch[1]);
      rule = daysMatch[2].trim();
    } else if (/^[A-Za-z]/.test(rule) && !/^(off|closed)$/.test(rule)) {
      return null; // sélecteur inconnu (mois, semaines…)
    }
    if (!days) return null;

    if (/^(off|closed)$/.test(rule)) {
      for (const day of days) week[day] = [];
      continue;
    }
    // Lecture des plages horaires de la règle, ex. « 08:30-12:30,14:30-19:00 »
    const ranges = [];
    for (const span of rule.split(',')) {
      const [from, to] = span.trim().split('-');
      const start = parseTime(from ?? '');
      const end = parseTime(to ?? '');
      if (start === null || end === null) return null;
      ranges.push([start, end <= start ? end + 24 * 60 : end]); // fin < début : finit le lendemain
    }
    for (const day of days) week[day] = ranges;
  }

  // Conversion en minutes depuis lundi 00:00, pour tester facilement « ouvert maintenant ? »
  const intervals = [];
  week.forEach((ranges, day) => {
    for (const [start, end] of ranges) intervals.push([day * 1440 + start, day * 1440 + end]);
  });
  return intervals;
}

// Minute de la semaine correspondant à une date (lundi 00:00 = 0)
function minuteOfWeek(date) {
  const day = (date.getDay() + 6) % 7; // lundi = 0
  return day * 1440 + date.getHours() * 60 + date.getMinutes();
}

// 1290 -> « 21:30 »
function clock(minutes) {
  const inDay = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(inDay / 60)).padStart(2, '0')}:${String(inDay % 60).padStart(2, '0')}`;
}

// Texte lisible : « à 21:30 », « demain à 09:00 » ou « lundi à 09:00 »
function whenLabel(target, now) {
  const dayDiff = Math.floor(target / 1440) - Math.floor(now / 1440);
  const time = clock(target);
  if (dayDiff === 0) return `à ${time}`;
  if (dayDiff === 1) return `demain à ${time}`;
  return `${DAY_NAMES[Math.floor(target / 1440) % 7]} à ${time}`;
}

/** État à un instant : { state: 'open' | 'closed' | 'unknown', text }. */
export function openingStatus(value, date = new Date()) {
  const intervals = parseOpeningHours(value);
  if (!intervals) return { state: 'unknown', text: 'Horaires inconnus' };
  if (intervals.length === 0) return { state: 'closed', text: 'Fermé' };

  const now = minuteOfWeek(date);
  // Chaque plage est testée cette semaine et la semaine suivante (plages qui débordent sur lundi)
  const shifted = intervals.flatMap(([start, end]) => [
    [start - WEEK_MIN, end - WEEK_MIN],
    [start, end],
    [start + WEEK_MIN, end + WEEK_MIN],
  ]);

  // Plages en cours en ce moment : ouvert ; on cherche alors l'heure de fermeture
  const current = shifted.filter(([start, end]) => start <= now && now < end);
  if (current.length) {
    // Plages qui se touchent (ex. 24/7 ou 00:00-24:00 tous les jours) : on prend la fin la plus lointaine
    let closing = Math.max(...current.map(([, end]) => end));
    for (let changed = true; changed; ) {
      changed = false;
      for (const [start, end] of shifted) {
        if (start <= closing && end > closing) {
          closing = end;
          changed = true;
        }
      }
    }
    if (closing - now >= WEEK_MIN) return { state: 'open', text: 'Ouvert 24h/24' };
    return { state: 'open', text: `Ouvert · ferme ${whenLabel(closing, now)}` };
  }

  // Fermé : on cherche la prochaine ouverture
  const next = shifted.map(([start]) => start).filter((start) => start > now);
  if (!next.length) return { state: 'closed', text: 'Fermé' };
  return { state: 'closed', text: `Fermé · ouvre ${whenLabel(Math.min(...next), now)}` };
}
