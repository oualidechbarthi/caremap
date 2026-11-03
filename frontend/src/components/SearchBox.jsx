import { useEffect, useState } from 'react';
import { Loader2, MapPin, Search, X } from 'lucide-react';
import { useDebouncedValue } from '../hooks.js';

/** Recherche d'une ville / adresse (via /api/search → Nominatim). */
export default function SearchBox({ onSelect }) {
  // query = texte tapé ; results = propositions ; searching = recherche en cours ; open = liste visible
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  // On attend 400 ms après la dernière touche avant de chercher (pas une requête par lettre)
  const debouncedQuery = useDebouncedValue(query.trim(), 400);

  useEffect(() => {
    if (debouncedQuery.length < 2) {
      setResults([]);
      return undefined;
    }

    // AbortController : annule la recherche précédente si l'utilisateur continue de taper
    const controller = new AbortController();
    setSearching(true);
    fetch(`/api/search?${new URLSearchParams({ q: debouncedQuery })}`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : { results: [] }))
      .then((payload) => {
        setResults(payload.results ?? []);
        setSearching(false);
      })
      .catch((error) => {
        if (error.name !== 'AbortError') setSearching(false);
      });
    return () => controller.abort();
  }, [debouncedQuery]);

  // Clic sur un résultat : la carte se déplace (onSelect) et la liste se ferme
  const choose = (place) => {
    onSelect(place);
    setQuery(place.name);
    setOpen(false);
  };

  return (
    <div className={`search ${open && results.length ? 'has-results' : ''}`}>
      <div className="search-field">
        <Search size={17} className="search-icon" />
        <input
          type="search"
          value={query}
          placeholder="Rechercher une ville, une adresse…"
          aria-label="Rechercher un lieu"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          // Petit délai : laisse le temps au clic sur un résultat d'être pris en compte
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          // Entrée = premier résultat ; Échap = fermer la liste
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) choose(results[0]);
            if (event.key === 'Escape') setOpen(false);
          }}
        />
        {searching ? (
          <Loader2 size={16} className="spin search-trailing" />
        ) : (
          query && (
            <button type="button" className="search-clear" aria-label="Effacer" onClick={() => setQuery('')}>
              <X size={15} />
            </button>
          )
        )}
      </div>

      {open && results.length > 0 && (
        <ul className="search-results" role="listbox">
          {results.map((place, index) => (
            <li key={`${place.latitude}-${place.longitude}`} style={{ '--i': index }}>
              <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => choose(place)}>
                <MapPin size={15} />
                <span>
                  <strong>{place.name}</strong>
                  <small>{place.label}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
