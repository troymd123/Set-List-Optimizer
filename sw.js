// Minimal service worker — no caching, just satisfies PWA install requirement
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
// No fetch handler — all requests go straight to network
