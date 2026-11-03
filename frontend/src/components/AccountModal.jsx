import { useEffect, useState } from 'react';
import { Building2, Loader2, LogOut, User, X } from 'lucide-react';

// Les deux types de comptes proposés à l'inscription
const ROLES = [
  {
    id: 'citizen',
    icon: User,
    title: 'Citoyen',
    text: 'Trouver les services proches. Facultatif : l’application marche aussi sans compte.',
  },
  {
    id: 'pro',
    icon: Building2,
    title: 'Pro',
    text: 'Pharmacie, supermarché, clinique… : population par quartier et zones où s’installer.',
  },
];

/** Texte d'erreur lisible à partir d'une réponse du backend. */
function errorText(payload, status) {
  // FastAPI renvoie une liste de détails quand un champ ne respecte pas les règles (422)
  if (Array.isArray(payload?.detail)) return 'Vérifiez les champs : mot de passe de 8 caractères minimum.';
  return payload?.detail || `Le serveur a répondu ${status}.`;
}

/**
 * Fenêtre « Mon compte » : connexion, inscription (citoyen ou pro),
 * ou, si l'on est déjà connecté, les informations du compte et la déconnexion.
 */
export default function AccountModal({ account, initialRole = 'citizen', onClose, onSignedIn, onSignOut }) {
  // tab = 'login' (se connecter) ou 'register' (créer un compte)
  const [tab, setTab] = useState(initialRole === 'pro' ? 'register' : 'login');
  const [role, setRole] = useState(initialRole);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // La touche Échap ferme la fenêtre
  useEffect(() => {
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Envoi du formulaire : POST /api/auth/login ou /api/auth/register
  const submit = async (event) => {
    event.preventDefault(); // empêche le navigateur de recharger la page
    setBusy(true);
    setError('');
    const body = tab === 'login' ? { email, password } : { email, password, role, display_name: displayName };
    try {
      const response = await fetch(`/api/auth/${tab}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorText(payload, response.status));
      onSignedIn(payload.token, payload.user); // App.jsx garde le jeton et ferme la fenêtre
    } catch (submitError) {
      setError(submitError.message || 'Connexion impossible.');
    } finally {
      setBusy(false);
    }
  };

  return (
    // Clic sur le fond sombre = fermer ; un clic dans la fenêtre ne la ferme pas
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal account-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-title"
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="icon-button modal-close" aria-label="Fermer" onClick={onClose}>
          <X size={18} />
        </button>

        {account ? (
          <>
            {/* Déjà connecté : informations du compte et déconnexion */}
            <span className="kicker">Mon compte</span>
            <h2 id="account-title">{account.display_name || account.email}</h2>
            <p className="account-line">
              {account.role === 'pro' ? <Building2 size={16} /> : <User size={16} />}
              {account.role === 'pro' ? 'Compte pro' : 'Compte citoyen'} · {account.email}
            </p>
            {account.role === 'pro' && (
              <p className="modal-note">
                En mode « Toute la zone », activez « Population (H3) » pour voir les habitants mal desservis et les
                zones prioritaires.
              </p>
            )}
            <p className="modal-note">Votre compte ne contient aucune position ni aucun trajet.</p>
            <button type="button" className="primary-button account-logout" onClick={onSignOut}>
              <LogOut size={16} />
              Se déconnecter
            </button>
          </>
        ) : (
          <form onSubmit={submit}>
            {/* Onglets : se connecter / créer un compte */}
            <span className="kicker">Mon compte</span>
            <h2 id="account-title">{tab === 'login' ? 'Se connecter' : 'Créer un compte'}</h2>
            <div className="account-tabs" role="group" aria-label="Connexion ou inscription">
              <button type="button" className={tab === 'login' ? 'active' : ''} onClick={() => setTab('login')}>
                Connexion
              </button>
              <button type="button" className={tab === 'register' ? 'active' : ''} onClick={() => setTab('register')}>
                Inscription
              </button>
            </div>

            {/* Inscription seulement : choix du type de compte */}
            {tab === 'register' && (
              <div className="account-roles">
                {ROLES.map(({ id, icon: Icon, title, text }) => (
                  <button
                    type="button"
                    key={id}
                    className={`account-role ${role === id ? 'active' : ''}`}
                    aria-pressed={role === id}
                    onClick={() => setRole(id)}
                  >
                    <Icon size={18} />
                    <strong>{title}</strong>
                    <small>{text}</small>
                  </button>
                ))}
              </div>
            )}

            {/* Champs du formulaire */}
            {tab === 'register' && (
              <label className="account-field">
                <span>{role === 'pro' ? 'Nom de l’établissement' : 'Prénom (facultatif)'}</span>
                <input value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} />
              </label>
            )}
            <label className="account-field">
              <span>Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label className="account-field">
              <span>Mot de passe {tab === 'register' && '(8 caractères minimum)'}</span>
              <input
                type="password"
                required
                minLength={tab === 'register' ? 8 : undefined}
                autoComplete={tab === 'login' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>

            {error && <small className="account-error">{error}</small>}

            <button type="submit" className="primary-button" disabled={busy}>
              {busy && <Loader2 size={16} className="spin" />}
              {tab === 'login' ? 'Se connecter' : 'Créer mon compte'}
            </button>
            <p className="modal-note">
              Le mot de passe est enregistré sous forme d’empreinte chiffrée, jamais en clair. Aucune position n’est
              liée à votre compte.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}
