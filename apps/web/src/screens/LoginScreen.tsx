import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useLogin } from '../api/queries.js';
import { navigate } from '../state/router.js';

export function LoginScreen() {
  const login = useLogin();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    login.mutate(
      { username, password },
      {
        onSuccess: () => {
          navigate({ name: 'home' }, { replace: true });
        },
      },
    );
  };

  const error = login.error;
  return (
    <div className="form-page">
      <h1>Lumen</h1>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Identifiant</span>
          <input
            data-nav
            data-nav-default
            autoComplete="username"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
            }}
          />
        </label>
        <label className="field">
          <span>Mot de passe</span>
          <input
            data-nav
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        {error !== null && (
          <p className="error" role="alert">
            {error instanceof ApiError && error.status === 401
              ? 'Identifiant ou mot de passe incorrect.'
              : error instanceof ApiError && error.code === 'rate_limited'
                ? 'Trop de tentatives. Patientez une minute.'
                : 'Connexion impossible pour le moment.'}
          </p>
        )}
        <button type="submit" className="button primary" data-nav disabled={login.isPending}>
          {login.isPending ? 'Connexion…' : 'Se connecter'}
        </button>
      </form>
    </div>
  );
}
