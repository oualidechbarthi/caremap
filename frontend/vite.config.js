// Configuration de Vite, l'outil qui lance le frontend en développement (npm run dev)
// et le compile pour la production (npm run build).
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  // Support de React (JSX, rechargement instantané pendant le développement)
  plugins: [react()],
  server: {
    // Adresse de développement : http://localhost:5173 ; host: true = accessible depuis le réseau local
    port: 5173,
    host: true,
    // Proxy : en développement, les appels à /api sont transmis au backend FastAPI (port 8000)
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
