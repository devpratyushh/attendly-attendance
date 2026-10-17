import { store } from './offline-core.js';
import { createSyncEngine } from './sync-engine.js';
const CACHE = 'attendly-shell-v6';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/manifest.json', '/icon.svg', '/offline-core.js', '/sync-engine.js'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => (key.startsWith('facerecog-') || key.startsWith('attendly-shell-')) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/static/')) return;
  const shell = event.request.mode === 'navigate' || ['/assets/', '/src/', '/node_modules/.vite/', '/@vite/'].some(prefix => url.pathname.startsWith(prefix)) || ['/offline-core.js', '/sync-engine.js', '/@react-refresh', '/icon.svg', '/manifest.json'].includes(url.pathname);
  if (!shell) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(event.request, copy))); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (event.request.mode === 'navigate' ? await caches.match('/') : new Response('Offline asset unavailable', { status: 503 }))));
});
self.addEventListener('sync', event => {
  if (!event.tag.startsWith('attendance:')) return;
  const owner = Number(event.tag.split(':')[1]);
  event.waitUntil((async () => {
    await createSyncEngine().sync(owner);
    const jobs = await store.jobs(owner);
    if (jobs.some(job => job.ready && ['failed', 'saved_offline', 'waiting_sync'].includes(job.state))) throw new Error('Pending attendance will retry when the browser permits');
  })());
});
