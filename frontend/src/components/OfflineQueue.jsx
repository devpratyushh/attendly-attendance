import { useEffect, useState } from 'react';
import { offlineModules, triggerSync, queueChanged } from '../offline/client';
import Icon from './Icon';

export default function OfflineQueue({ owner, onSelect, onResumeCapture }) {
  const [jobs, setJobs] = useState([]); const [error, setError] = useState(''); const [durable, setDurable] = useState(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => { try { const { store } = await offlineModules(); const rows = await store.jobs(owner); if (active) setJobs(rows); } catch (e) { if (active) setError(e.message); } };
    const sync = () => { triggerSync(owner).catch(() => {}).finally(refresh); };
    refresh(); sync();
    navigator.storage?.persisted?.().then(value => { if (active) setDurable(value); });
    window.addEventListener('attendance-queue', refresh); window.addEventListener('online', sync); window.addEventListener('offline', refresh); window.addEventListener('focus', sync);
    const timer = setInterval(sync, 20000);
    return () => { active = false; clearInterval(timer); window.removeEventListener('attendance-queue', refresh); window.removeEventListener('online', sync); window.removeEventListener('offline', refresh); window.removeEventListener('focus', sync); };
  }, [owner]);
  const labels = { capturing: 'Unfinished capture', saved_offline: 'Saved Offline', waiting_sync: 'Waiting to Sync', uploading: 'Uploading', processing: 'Processing', needs_review: 'Ready for Review', confirming: 'Finalizing', completed: 'Completed', failed: 'Failed', auth_required: 'Sign in to Sync' };
  const pending = jobs.filter(job => job.state !== 'completed');
  return <section className="offline-queue card"><div className="flex justify-between items-center"><div><h3>On this device</h3><p className="text-xs text-muted mt-2">{pending.length} pending session{pending.length !== 1 ? 's' : ''} · encrypted private storage</p></div><span className={`connection-pill ${navigator.onLine ? '' : 'offline'}`}>{navigator.onLine ? 'Connected' : 'Offline'}</span></div>
    {durable === false && pending.length > 0 && <p className="storage-note">Browser storage may be evicted under pressure. Keep this device’s site data until pending sessions complete.</p>}
    {error && <div className="notice error">{error}</div>}
    {!jobs.length && <p className="text-xs text-muted mt-3">Captured photos stay here until attendance is committed on the server, then are deleted automatically.</p>}
    {jobs.slice(0, 12).map(job => <div className="queue-row" key={job.id}><div><strong>{job.label || 'Attendance capture'}</strong><span>{new Date(job.createdAt).toLocaleString('en-IN')} · {job.mode === 'panorama' ? '3-Shot Panorama' : 'Single Shot'}</span>{job.error && <p className="queue-error">{job.error}</p>}</div><div className="queue-actions">{job.state === 'failed' && job.serverSession && <button className="text-button" onClick={async () => { const { store } = await offlineModules(); await store.savePrivate(owner, `confirmation:${job.id}`, null); const value = await store.update(job.id, { confirmationPending: false, state: 'needs_review', nextAttempt: 0 }); queueChanged(); onSelect(value); }}>Review & resolve</button>}<span className={`badge badge-${job.state === 'completed' ? 'approved' : job.state === 'failed' ? 'rejected' : 'pending'}`}>{labels[job.state]}</span>{job.state === 'capturing' ? <><button className="text-button" onClick={() => onResumeCapture(job)}>Resume</button><button className="text-button danger-text" onClick={async () => { if (!window.confirm('Discard this unfinished capture and its private local photos?')) return; try { const { store } = await offlineModules(); await store.discardDraft(owner, job.id); queueChanged(); } catch (e) { setError(e.message); } }}>Discard draft</button></> : job.state === 'needs_review' ? <button className="text-button" onClick={() => onSelect(job)}>Open review<Icon name="arrow" size={13}/></button> : ['failed', 'auth_required', 'saved_offline', 'waiting_sync'].includes(job.state) ? <button className="text-button" onClick={() => job.state === 'auth_required' ? window.dispatchEvent(new Event('auth-expired')) : triggerSync(owner, true).catch(e => setError(e.message))}>{job.state === 'auth_required' ? 'Sign in again' : 'Retry sync'}</button> : null}</div></div>)}
  </section>;
}
