import { store as defaultStore } from './offline-core.js';
export function retryDelay(attempts, random = Math.random) { return Math.min(300000, 2000 * 2 ** Math.min(attempts, 8)) * (.8 + random() * .4); }
export async function http(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(path, { credentials: 'include', ...options, signal: options.signal || controller.signal });
    let value;
    try { value = await response.json(); } catch {
      if (response.ok) throw new Error('The server response was interrupted. The next retry will check saved results.');
      value = {};
    }
    if (!response.ok) { const error = new Error(typeof value.detail === 'string' ? value.detail : 'The server could not complete this operation'); error.status = response.status; throw error; }
    return value;
  } finally { clearTimeout(timeout); }
}
export function createSyncEngine({ store = defaultStore, transport = http, online = () => navigator.onLine, notify = () => {} } = {}) {
  async function runJob(owner, id, { force = false } = {}) {
    const identity = await store.get('metadata', 'current-user');
    if (identity?.signedOut) return;
    let job = await store.get('jobs', id);
    if (!job || job.owner !== owner || !job.ready || job.state === 'completed' || (!force && job.nextAttempt > Date.now())) return;
    if (!online()) { await store.update(id, { state: 'saved_offline' }); notify(); return; }
    const lease = crypto.randomUUID();
    if (!await store.acquire(id, lease)) return;
    const heartbeat = setInterval(() => { store.release(id, lease, true).catch(() => {}); }, 45000);
    const patch = async value => { job = await store.update(id, value); notify(); };
    try {
      const user = await transport('/api/auth/me');
      if (user.id !== owner || user.role !== 'teacher') { const error = new Error('Sign in with the teacher account that captured this session'); error.status = 401; throw error; }
      if (!job.serverSession) {
        const body = new FormData(); body.append('periods', job.periods); body.append('assignment_id', job.assignmentId);
        body.append('client_request_id', job.id); body.append('capture_mode', job.mode); body.append('captured_at', job.createdAt);
        await patch({ state: 'waiting_sync' });
        const session = await transport('/api/sessions/create', { method: 'POST', body });
        if (!session?.session_id) throw new Error('The server did not acknowledge this session. Your capture is retained.');
        await patch({ serverSession: session });
      }
      // A previous successful commit may have lost its response or local acknowledgement.
      const server = await transport(`/api/sessions/${job.serverSession.session_id}`);
      if (!['active', 'confirmed'].includes(server.status)) throw new Error('The session state could not be verified. Your capture is retained.');
      if (server.status === 'confirmed') { await store.cleanupCommitted(id, server); notify(); return; }
      const frames = (await store.all('frames')).filter(frame => frame.jobId === id).sort((a, b) => a.slot - b.slot);
      for (const frame of frames) {
        if (job.uploaded?.[frame.slot]) continue;
        await patch({ state: 'uploading', error: null });
        const blob = await store.readFrame(owner, frame.id);
        const body = new FormData(); body.append('photo', blob, `view-${frame.slot + 1}.jpg`); body.append('client_photo_id', frame.id.replace(':', '_'));
        const result = await transport(`/api/sessions/${job.serverSession.session_id}/upload`, { method: 'POST', body });
        if (!result?.class_photo_id) throw new Error('The server did not acknowledge this photo. It will be retried safely.');
        await patch({ uploaded: { ...job.uploaded, [frame.slot]: result.class_photo_id }, state: 'processing' });
      }
      const analysis = await transport(`/api/sessions/${job.serverSession.session_id}/analysis`);
      if (!Array.isArray(analysis?.results)) throw new Error('Processing results are incomplete. The images are retained for retry.');
      await store.savePrivate(owner, `analysis:${id}`, analysis);
      const confirmation = await store.readPrivate(owner, `confirmation:${id}`);
      if (confirmation) {
        await patch({ state: 'confirming' });
        const body = new FormData(); body.append('records', JSON.stringify(confirmation));
        if (job.confirmationPeriods != null) body.append('periods', job.confirmationPeriods);
        await transport(`/api/sessions/${job.serverSession.session_id}/confirm`, { method: 'POST', body });
        const receipt = await transport(`/api/sessions/${job.serverSession.session_id}`);
        await store.cleanupCommitted(id, receipt);
        notify();
      } else await patch({ state: 'needs_review', attempts: 0, nextAttempt: 0, error: null });
    } catch (error) {
      const attempts = (job.attempts || 0) + 1;
      const auth = error.status === 401;
      const permanent = [400, 403, 404, 409, 422].includes(error.status);
      await patch({ state: auth ? 'auth_required' : !online() ? 'saved_offline' : 'failed', attempts,
        nextAttempt: auth || permanent ? Number.MAX_SAFE_INTEGER : Date.now() + retryDelay(attempts),
        error: error.message || 'Upload interrupted. Your encrypted photos are retained.' });
    } finally { clearInterval(heartbeat); await store.release(id, lease); }
  }
  async function sync(owner, options) {
    for (const job of await store.jobs(owner)) {
      // Ready-for-review items do not repeatedly upload or run recognition.
      if (job.state === 'needs_review' && !job.confirmationPending && !options?.force && job.updatedAt > Date.now() - 60000) continue;
      await runJob(owner, job.id, options);
    }
  }
  return { sync, runJob };
}
