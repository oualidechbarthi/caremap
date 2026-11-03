// « Hooks » React réutilisables (fonctions qui commencent par use...) et petites aides.
import { useEffect, useRef, useState } from 'react';

/** Renvoie `value` seulement après `delay` ms sans changement (évite une requête par mouvement). */
export function useDebouncedValue(value, delay) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}

// Respecte le réglage « réduire les animations » du système de l'utilisateur
const prefersReducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Fait « défiler » un nombre vers sa nouvelle valeur (easing cubique). */
export function useAnimatedNumber(target, duration = 700) {
  const [value, setValue] = useState(target);
  const valueRef = useRef(target);

  useEffect(() => {
    const from = valueRef.current;
    if (from === target || prefersReducedMotion()) {
      valueRef.current = target;
      setValue(target);
      return undefined;
    }

    let frame;
    const start = performance.now();
    // Appelée à chaque image (~60 fois par seconde) jusqu'à la fin de l'animation
    const tick = (now) => {
      const progress = Math.min((now - start) / duration, 1);
      const eased = 1 - (1 - progress) ** 3;
      valueRef.current = from + (target - from) * eased;
      setValue(valueRef.current);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    // Nettoyage : si la valeur change pendant l'animation, on arrête l'ancienne
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}

/** Lit/écrit une valeur dans localStorage sans planter si le stockage est bloqué. */
export function readStorage(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // stockage indisponible (navigation privée…) : on ignore
  }
}
