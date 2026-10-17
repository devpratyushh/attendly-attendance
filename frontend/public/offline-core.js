// Shared by the page and service worker. Images and sensitive drafts are encrypted in IndexedDB.
export const STATES = {
  capturing: 'Capturing', saved_offline: 'Saved Offline', waiting_sync: 'Waiting to Sync',
  uploading: 'Uploading', processing: 'Processing', needs_review: 'Ready for Review',
  confirming: 'Finalizing', completed: 'Completed', failed: 'Failed', auth_required: 'Sign in to Sync',
};
const request = value => new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
const finished = transaction => new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Local storage transaction failed')); });
export function createStore(name = 'attendly-offline-v1', { estimateStorage = () => globalThis.navigator?.storage?.estimate?.() } = {}) {
  let connection;
  async function db() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const opening = indexedDB.open(name, 1);
      opening.onupgradeneeded = () => { for (const store of ['keys', 'jobs', 'frames', 'metadata']) opening.result.createObjectStore(store, { keyPath: 'id' }); };
      opening.onsuccess = () => { const result = opening.result; result.onversionchange = () => { result.close(); connection = null; }; resolve(result); };
      opening.onerror = () => { connection = null; reject(opening.error); };
      opening.onblocked = () => reject(new Error('Close other attendance tabs to update local storage'));
    });
    return connection;
  }
  async function get(table, id) { const conn = await db(); return request(conn.transaction(table).objectStore(table).get(id)); }
  async function all(table) { const conn = await db(); return request(conn.transaction(table).objectStore(table).getAll()); }
  async function put(table, value) { const conn = await db(); const tx = conn.transaction(table, 'readwrite'); const done = finished(tx); tx.objectStore(table).put(value); await done; return value; }
  async function key(owner) {
    const existing = await get('keys', String(owner));
    if (existing) return existing.key;
    const generated = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const conn = await db(); const tx = conn.transaction('keys', 'readwrite'); const done = finished(tx); const table = tx.objectStore('keys');
    // Read-and-add in a single transaction prevents two tabs replacing a key.
    const read = table.get(String(owner));
    let selected;
    read.onsuccess = () => { selected = read.result?.key || generated; if (!read.result) table.add({ id: String(owner), key: selected }); };
    await done; return selected;
  }
  async function encrypt(owner, value, context) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const bytes = value instanceof Blob ? await value.arrayBuffer() : new TextEncoder().encode(JSON.stringify(value));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(context) }, await key(owner), bytes);
    return { iv, encrypted };
  }
  async function decrypt(owner, value, context, type) {
    const record = await get('keys', String(owner));
    if (!record) throw new Error('The device encryption key is unavailable. Keep the originals and contact support.');
    const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: value.iv, additionalData: new TextEncoder().encode(context) }, record.key, value.encrypted);
    return type ? new Blob([bytes], { type }) : JSON.parse(new TextDecoder().decode(bytes));
  }
  async function newJob(owner, fields) {
    if (!Number.isInteger(fields.periods) || fields.periods < 1 || fields.periods > 4) throw new Error('Choose between 1 and 4 periods.');
    const job = { id: crypto.randomUUID(), owner, createdAt: new Date().toISOString(), updatedAt: Date.now(),
      mode: 'single', state: 'capturing', frameIds: [], uploaded: {}, attempts: 0, nextAttempt: 0, ...fields };
    await put('jobs', job); return job;
  }
  async function update(id, patch) {
    const conn = await db(); const tx = conn.transaction('jobs', 'readwrite'); const done = finished(tx); const table = tx.objectStore('jobs');
    const read = table.get(id); let value;
    read.onsuccess = () => { if (!read.result) { tx.abort(); return; } value = { ...read.result, ...patch, updatedAt: Date.now() }; table.put(value); };
    await done; return value;
  }
  async function saveFrame(owner, jobId, slot, blob) {
    const job = await get('jobs', jobId);
    if (!job || job.owner !== owner || job.ready || job.uploaded?.[slot]) throw new Error('This capture can no longer be changed. Add a new capture instead.');
    const estimate = await estimateStorage();
    if (estimate?.quota && estimate.quota - (estimate.usage || 0) < blob.size * 2 + 1024 * 1024) throw new Error('Device storage is low. Free space before capturing; nothing was uploaded or marked saved.');
    const id = `${jobId}:${slot}`;
    const envelope = await encrypt(owner, blob, `${owner}:${id}`);
    const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
    const frame = { id, owner, jobId, slot, contentHash, type: blob.type || 'image/jpeg', size: blob.size, ...envelope };
    const conn = await db(); const tx = conn.transaction(['frames', 'jobs'], 'readwrite'); const done = finished(tx);
    tx.objectStore('frames').put(frame);
    const read = tx.objectStore('jobs').get(jobId);
    read.onsuccess = () => { const current = read.result; if (!current || current.ready) { tx.abort(); return; } tx.objectStore('jobs').put({ ...current, frameIds: [...new Set([...current.frameIds, id])], updatedAt: Date.now() }); };
    try { await done; } catch (e) { if (e?.name === 'QuotaExceededError') throw new Error('Device storage is full. This photo was not saved. Free space and retake.'); throw e; }
    return frame;
  }
  async function markReady(owner, id) {
    const job = await get('jobs', id);
    const needed = job?.mode === 'panorama' ? 3 : 1;
    const frames = (await all('frames')).filter(frame => frame.jobId === id && frame.owner === owner);
    if (!job || job.owner !== owner || frames.length !== needed || frames.some(frame => !Number.isInteger(frame.slot) || frame.slot < 0 || frame.slot >= needed) || new Set(frames.map(frame => frame.slot)).size !== needed) throw new Error(`Capture all ${needed} required views before processing`);
    return update(id, { ready: true, state: globalThis.navigator?.onLine === false ? 'saved_offline' : 'waiting_sync' });
  }
  async function readFrame(owner, id) { const frame = await get('frames', id); if (!frame || frame.owner !== owner) throw new Error('Saved photo is unavailable for this account'); return decrypt(owner, frame, `${owner}:${id}`, frame.type); }
  async function savePrivate(owner, id, value) { return put('metadata', { id: `${owner}:${id}`, owner, ...await encrypt(owner, value, `${owner}:${id}`) }); }
  async function readPrivate(owner, id) { const value = await get('metadata', `${owner}:${id}`); return value ? decrypt(owner, value, `${owner}:${id}`) : null; }
  async function cleanupCommitted(id, receipt) {
    const job = await get('jobs', id);
    if (!job || !receipt || receipt.status !== 'confirmed' || receipt.session_id !== job.serverSession?.session_id) throw new Error('Server commit has not been verified. Local images were retained.');
    const frames = await all('frames');
    const receipts = receipt.processed_photos || [];
    if (frames.filter(frame => frame.jobId === id).some(frame => !receipts.some(item =>
      item.client_photo_id === frame.id.replace(':', '_') || item.content_hash === frame.contentHash || item.id === job.uploaded?.[frame.slot]))) {
      const error = new Error('This session is finalized, but some local photos have no processing receipt. Those photos were retained for resolution.');
      error.status = 409; throw error;
    }
    const conn = await db(); const tx = conn.transaction(['frames', 'jobs', 'metadata'], 'readwrite'); const done = finished(tx);
    for (const frame of frames) {
      if (frame.jobId === id) tx.objectStore('frames').delete(frame.id);
    }
    tx.objectStore('metadata').delete(`${job.owner}:analysis:${id}`);
    tx.objectStore('metadata').delete(`${job.owner}:confirmation:${id}`);
    tx.objectStore('metadata').delete(`${job.owner}:review:${id}`);
    tx.objectStore('metadata').delete(`${job.owner}:review-session:${receipt.session_id}`);
    tx.objectStore('jobs').put({ ...job, frameIds: [], state: 'completed', error: null, receipt: { session_id: receipt.session_id, status: receipt.status }, updatedAt: Date.now() });
    await done;
  }
  async function discardDraft(owner, id) {
    const job = await get('jobs', id);
    if (!job || job.owner !== owner || job.ready || job.serverSession) throw new Error('Uploaded or queued sessions cannot be discarded as an abandoned draft');
    const frames = await all('frames'); const conn = await db(); const tx = conn.transaction(['frames', 'jobs'], 'readwrite'); const done = finished(tx);
    for (const frame of frames.filter(f => f.jobId === id)) tx.objectStore('frames').delete(frame.id);
    tx.objectStore('jobs').delete(id); await done;
  }
  async function acquire(id, token, now = Date.now()) {
    const conn = await db(); const tx = conn.transaction('jobs', 'readwrite'); const done = finished(tx); const table = tx.objectStore('jobs'); let acquired = false;
    const read = table.get(id); read.onsuccess = () => { const job = read.result; if (job && (!job.leaseUntil || job.leaseUntil < now)) { acquired = true; table.put({ ...job, leaseToken: token, leaseUntil: now + 180000 }); } };
    await done; return acquired;
  }
  async function release(id, token, renew = false) {
    const conn = await db(); const tx = conn.transaction('jobs', 'readwrite'); const done = finished(tx); const table = tx.objectStore('jobs');
    const read = table.get(id); read.onsuccess = () => { const job = read.result; if (job?.leaseToken === token) table.put({ ...job, leaseToken: renew ? token : null, leaseUntil: renew ? Date.now() + 180000 : 0 }); };
    await done;
  }
  return { get, all, put, update, newJob, saveFrame, markReady, readFrame, savePrivate, readPrivate, cleanupCommitted, discardDraft, acquire, release,
    jobs: async owner => (await all('jobs')).filter(job => job.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    close: async () => { (await db()).close(); connection = null; } };
}
export const store = createStore();
export async function rememberUser(user) {
  await store.put('metadata', { id: 'current-user', user, validUntil: Date.now() + 12 * 3600000 });
}
export async function cachedUser() {
  const saved = await store.get('metadata', 'current-user');
  return saved?.user?.role === 'teacher' && saved.validUntil > Date.now() ? { ...saved.user, offline: true } : null;
}
export async function forgetUser() { await store.put('metadata', { id: 'current-user', user: null, signedOut: true }); }
