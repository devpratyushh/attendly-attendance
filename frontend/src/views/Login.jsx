import { useState } from 'react';
import { api } from '../api';
import Icon from '../components/Icon';

export default function Login({ onLogin, portal = 'student', onPortalChange }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const changePortal = value => { onPortalChange?.(value); setError(''); };
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try { onLogin(await api.login({ ...data, portal })); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return <div className={`login-page role-${portal}`}>
    <section className="login-story">
      <div className="brand"><span className="brand-symbol"><Icon name="face" size={24}/></span><span>Attendly</span></div>
      <div className="story-copy"><div className="eyebrow">A little less admin. A little more learning.</div><h1>Every class.<br/>Every student.<br/><em>Accounted for.</em></h1><p>A calm, connected space for your school’s attendance. Built around the people who make learning happen.</p>
        <div className="story-illustration" aria-hidden="true"><div className="illustration-top"><span className="illustration-dot"/>Your classroom, at a glance<span className="illustration-status">All set</span></div>{[76, 92, 61].map((n, i) => <div className="illustration-row" key={n}><span className="illustration-avatar">{['A', 'S', 'R'][i]}</span><div><div className="illustration-line" style={{ width: `${n}%` }}/><div className="illustration-line small"/></div><span className="illustration-check"><Icon name="check" size={14}/></span></div>)}<div className="illustration-bottom"><Icon name="shield" size={15}/>The right access, for everyone.</div></div>
      </div><div className="story-footer">More time for what matters.</div>
    </section>
    <section className="login-form-side"><div className="login-card">
      <span className="login-portal-icon"><Icon name={portal === 'admin' ? 'shield' : portal === 'teacher' ? 'book' : 'school'} size={24}/></span>
      <div className="eyebrow">{portal === 'admin' ? 'Administration' : 'Your school workspace'}</div><h2>Welcome back.</h2><p className="login-description">Sign in to your {portal === 'admin' ? 'admin' : portal} account to continue.</p>
      {portal !== 'admin' && <div className="portal-tabs" role="tablist" aria-label="Choose sign-in portal"><button role="tab" aria-selected={portal === 'student'} className={portal === 'student' ? 'active' : ''} onClick={() => changePortal('student')}><Icon name="school" size={17}/>Student</button><button role="tab" aria-selected={portal === 'teacher'} className={portal === 'teacher' ? 'active' : ''} onClick={() => changePortal('teacher')}><Icon name="book" size={17}/>Teacher</button></div>}
      <form key={portal} onSubmit={submit}>
        <label className="field">Username<input name="username" placeholder={portal === 'admin' ? 'Enter admin username' : 'Enter your username'} autoComplete="username" required autoCapitalize="none"/></label>
        <label className="field">Password<div className="password-input"><input name="password" placeholder="Enter your password" type={showPassword ? 'text' : 'password'} autoComplete="current-password" required/><button type="button" aria-label={showPassword ? 'Hide password' : 'Show password'} onClick={() => setShowPassword(!showPassword)}>{showPassword ? 'Hide' : 'Show'}</button></div></label>
        {error && <div className="notice error" role="alert">{error}</div>}
        <button className="btn btn-primary btn-full login-submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}<Icon name="arrow" size={18}/></button>
      </form>
      <div className="login-help"><Icon name="shield" size={16}/><p>Accounts are provided by your school.<br/>Need access? Contact your class teacher or admin.</p></div>
      <button className="admin-link" onClick={() => changePortal(portal === 'admin' ? 'student' : 'admin')}>{portal === 'admin' ? '← Back to student & teacher sign in' : 'Administrator sign in'}{portal !== 'admin' && <Icon name="arrow" size={14}/>}</button>
    </div><div className="login-bottom">One school. One connected workspace.</div></section>
  </div>;
}
