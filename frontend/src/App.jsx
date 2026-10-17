import { useEffect, useState } from 'react';
import AppRoutes from './AppRoutes';
import { api } from './api';
import Dialog from './components/Dialog';
import './index.css';
import './portal.css';
import './color.css';
import { persistIdentity, offlineIdentity, forgetIdentity, locallySignedOut } from './offline/client';

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [passwordOpen, setPasswordOpen] = useState(false);
  useEffect(() => {
    locallySignedOut().catch(() => false).then(async signedOut => {
      if (signedOut) { api.logout().catch(() => {}); return; }
      try { const value = await api.me(); setUser(value); persistIdentity(value).catch(() => {}); }
      catch (e) { if (!e.status) { const cached = await offlineIdentity().catch(() => null); if (cached) { setUser(cached); } } }
    }).finally(() => setLoading(false));
    const expired = () => { setUser(null); forgetIdentity().catch(() => {}); };
    window.addEventListener('auth-expired', expired);
    return () => window.removeEventListener('auth-expired', expired);
  }, []);
  const signOut = async () => {
    await forgetIdentity().catch(() => {}); setPasswordOpen(false); setUser(null);
    try { await api.logout(); } catch { /* Local sign-out takes effect even offline; server cookie is revoked on reconnect. */ }
  };
  if (loading) return <div className="loading full-screen"><div className="spinner"/><span>Opening your workspace…</span></div>;
  return <>
    <AppRoutes user={user} onLogin={value=>{setUser(value);persistIdentity(value).catch(()=>{});}} onPassword={()=>setPasswordOpen(true)} onSignOut={signOut}/>
    {passwordOpen && user && <div className={`role-${user.role}`}><PasswordDialog onClose={()=>setPasswordOpen(false)} onChanged={()=>{setPasswordOpen(false);setUser(null);forgetIdentity().catch(()=>{});}}/></div>}
  </>;
}

function PasswordDialog({ onClose, onChanged }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <Dialog title="Change your password" description="Use at least 8 characters. You’ll sign in again afterward." onClose={onClose}><form onSubmit={async e => {
    e.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try { await api.changePassword(data); onChanged(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  }}><label className="field">Current password<input name="current_password" type="password" autoComplete="current-password" required/></label><label className="field">New password<input name="new_password" type="password" autoComplete="new-password" minLength={8} required/></label>{error && <div className="notice error" role="alert">{error}</div>}<div className="dialog-actions"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Updating…' : 'Update password'}</button></div></form></Dialog>;
}
