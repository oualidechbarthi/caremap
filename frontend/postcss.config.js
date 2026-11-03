// PostCSS transforme le CSS à la compilation : Tailwind, puis Autoprefixer
// (ajoute automatiquement les préfixes nécessaires aux anciens navigateurs).
export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
}
