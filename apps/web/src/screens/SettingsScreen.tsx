import type { DeviceModel } from '@lumen/protocol';
import { type FormEvent, useState } from 'react';
import { ApiError } from '../api/client.js';
import { useAddPortal, useLogout, useMe, usePortals, useRemovePortal } from '../api/queries.js';
import { MergeSettings } from '../components/MergeSettings.js';
import { usePrefs } from '../state/prefs.js';
import { navigate } from '../state/router.js';
import { ALL_PORTALS, useCurrentPortal } from '../state/use-current-portal.js';

const DEVICES: DeviceModel[] = ['MAG250', 'MAG254', 'MAG322'];

/** Messages d'échec d'ajout : l'utilisateur doit savoir quoi corriger. */
function addError(err: Error): string {
  if (!(err instanceof ApiError)) return 'Serveur injoignable.';
  switch (err.code) {
    case 'portal_unreachable':
      return 'Portail injoignable : vérifiez l’adresse.';
    case 'portal_device_rejected':
      return 'Appareil refusé par le portail : vérifiez la MAC ou le modèle.';
    case 'portal_auth_failed':
      return 'Identifiants refusés par le portail.';
    case 'bad_request':
      return 'Adresse ou MAC mal formée.';
    default:
      return err.message;
  }
}

function AddPortalForm() {
  const add = useAddPortal();
  const setPortal = usePrefs((s) => s.setPortal);
  const [form, setForm] = useState({
    name: '',
    url: '',
    mac: '',
    device: 'MAG250' as DeviceModel,
    login: '',
    password: '',
  });
  const field =
    (key: keyof typeof form) =>
    (e: { target: { value: string } }): void => {
      setForm((f) => ({ ...f, [key]: e.target.value }));
    };
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    add.mutate(form, {
      onSuccess: (portal) => {
        setPortal(portal.id);
        navigate({ name: 'tv', genre: null });
      },
    });
  };
  return (
    <form className="form" onSubmit={submit}>
      <h2>Ajouter un portail</h2>
      <label className="field">
        <span>Nom</span>
        <input data-nav required value={form.name} onChange={field('name')} placeholder="Mon abonnement" />
      </label>
      <label className="field">
        <span>Adresse du portail</span>
        <input
          data-nav
          required
          type="url"
          value={form.url}
          onChange={field('url')}
          placeholder="http://exemple.com/c/"
        />
      </label>
      <label className="field">
        <span>Adresse MAC</span>
        <input data-nav required value={form.mac} onChange={field('mac')} placeholder="00:1A:79:XX:XX:XX" />
      </label>
      <label className="field">
        <span>Modèle d’appareil</span>
        <select data-nav value={form.device} onChange={field('device')}>
          {DEVICES.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Identifiant (facultatif)</span>
        <input data-nav autoComplete="off" value={form.login} onChange={field('login')} />
      </label>
      <label className="field">
        <span>Mot de passe (facultatif)</span>
        <input
          data-nav
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={field('password')}
        />
      </label>
      {add.error !== null && (
        <p className="error" role="alert">
          {addError(add.error)}
        </p>
      )}
      <button type="submit" className="button primary" data-nav disabled={add.isPending}>
        {add.isPending ? 'Vérification de l’abonnement…' : 'Ajouter'}
      </button>
    </form>
  );
}

/** Réglages : portails (choix, ajout, retrait) et session. */
export function SettingsScreen() {
  const me = useMe();
  const logout = useLogout();
  const { portal: current, portals } = useCurrentPortal();
  const setPortal = usePrefs((s) => s.setPortal);
  const remove = useRemovePortal();
  const admin = me.data?.role === 'admin';
  const realPortals = usePortals().data ?? [];

  return (
    <div className="form-page screen">
      <h1>Réglages</h1>
      <h2>Portails</h2>
      <div className="form">
        {portals.length === 0 && <p className="programme-now">Aucun portail pour le moment.</p>}
        {portals.map((p, i) => (
          <div className="card" key={p.id}>
            <div className="card-body">
              <strong>{p.name}</strong>
              <small>
                {p.id === ALL_PORTALS.id
                  ? 'chaque chaîne une seule fois, avec ses sources de secours'
                  : `${p.host} · ${p.macMasked} · ${p.device}`}
              </small>
            </div>
            <button
              type="button"
              className={`button${p.id === current?.id ? ' primary' : ''}`}
              data-nav
              {...(i === 0 ? { 'data-nav-default': true } : {})}
              aria-pressed={p.id === current?.id}
              onClick={() => {
                setPortal(p.id);
              }}
            >
              {p.id === current?.id ? 'Affiché' : 'Afficher'}
            </button>
            {admin && p.id !== ALL_PORTALS.id && (
              <button
                type="button"
                className="button"
                data-nav
                onClick={() => {
                  if (window.confirm(`Retirer le portail « ${p.name} » ?`)) remove.mutate(p.id);
                }}
              >
                Retirer
              </button>
            )}
          </div>
        ))}
      </div>
      {admin && <AddPortalForm />}
      {realPortals.length > 1 && <MergeSettings admin={admin} />}
      <h2>Session</h2>
      <p className="programme-now">Connecté en tant que {me.data?.username ?? '…'}.</p>
      <button
        type="button"
        className="button"
        data-nav
        onClick={() => {
          logout.mutate(undefined, {
            onSettled: () => {
              navigate({ name: 'login' }, { replace: true });
            },
          });
        }}
      >
        Se déconnecter
      </button>
    </div>
  );
}
