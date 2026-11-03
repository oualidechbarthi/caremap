// Point de départ du frontend : React affiche le composant <App /> dans la balise
// <div id="root"> de index.html. StrictMode aide à repérer les erreurs en développement.
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
