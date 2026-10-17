const coreUrl = new URL('/offline-core.js', window.location.origin).href;
const syncUrl = new URL('/sync-engine.js', window.location.origin).href;
const modules = Promise.all([import(/* @vite-ignore */ coreUrl), import(/* @vite-ignore */ syncUrl)]);
export async function offlineModules() { const [core, sync] = await modules; return { ...core, ...sync }; }
export async function persistIdentity(user) { const { rememberUser, store } = await offlineModules(); await rememberUser(user); for (const job of await store.jobs(user.id)) { if (job.state === 'auth_required') await store.update(job.id, { nextAttempt: 0, state: 'waiting_sync', error: null }); } queueChanged(); }
export async function offlineIdentity() { const { cachedUser } = await offlineModules(); return cachedUser(); }
export async function forgetIdentity() { const { forgetUser } = await offlineModules(); await forgetUser(); }
export async function cacheWorkspace(owner, key, data) { const { store } = await offlineModules(); await store.savePrivate(owner, key, data); }
export async function readWorkspace(owner, key) { const { store } = await offlineModules(); return store.readPrivate(owner, key); }
export function queueChanged() { window.dispatchEvent(new Event('attendance-queue')); }
export async function triggerSync(owner, force = false) {
  const { createSyncEngine } = await offlineModules();
  await createSyncEngine({ notify: queueChanged }).sync(owner, { force });
  const registration = await navigator.serviceWorker?.getRegistration?.();
  if (registration?.sync) { try { await registration.sync.register(`attendance:${owner}`); } catch { /* Foreground retry remains available. */ } }
}

export async function locallySignedOut() { const { store } = await offlineModules(); return Boolean((await store.get('metadata', 'current-user'))?.signedOut); }
