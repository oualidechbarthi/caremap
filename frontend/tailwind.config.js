// Configuration de Tailwind CSS (bibliothèque de classes CSS utilitaires).
// L'essentiel du style de CareMap est écrit à la main dans src/index.css.
/** @type {import('tailwindcss').Config} */
export default {
  // Fichiers analysés par Tailwind pour ne garder que les classes réellement utilisées
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  // Couleurs supplémentaires disponibles (ex. bg-brand-500)
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#ecfdf5',
          500: '#10b981',
          600: '#059669',
          700: '#047857',
        },
        desert: {
          amber: '#f59e0b',
          rose: '#f43f5e',
          red: '#dc2626',
        }
      }
    },
  },
  plugins: [],
}
