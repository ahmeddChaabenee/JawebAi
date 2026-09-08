import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { loginRequest } from '../lib/api.ts';

export function Login({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  async function submit() {
    if (!email.trim() || !password) return;
    setBusy(true); setError('');
    const result = await loginRequest(email.trim(), password);
    setBusy(false);
    if (!result) { setError('Identifiants incorrects.'); return; }
    onSignedIn(result.token);
    navigate('/app');
  }

  return (
    <div className="gate">
      <div className="card">
        <Link to="/" className="brand" style={{ paddingBottom: 14 }}>
          <span className="mark">◆</span> Assistant
        </Link>
        <p className="sub" style={{ margin: '0 0 6px' }}>Connectez-vous à votre espace.</p>

        <label className="f" htmlFor="email">Adresse e-mail</label>
        <input id="email" type="email" autoComplete="username" placeholder="vous@exemple.com"
          value={email} onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} />

        <label className="f" htmlFor="pwd">Mot de passe</label>
        <input id="pwd" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()} />

        {error && <div className="err">{error}</div>}

        <button className="btn" style={{ width: '100%', marginTop: 14 }} disabled={busy} onClick={submit}>
          {busy ? 'Connexion…' : 'Se connecter'}
        </button>

        <div className="sub" style={{ marginTop: 16, textAlign: 'center' }}>
          <Link to="/">← Retour à l'accueil</Link>
        </div>
      </div>
    </div>
  );
}
