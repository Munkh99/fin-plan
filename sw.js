const CACHE = 'payoff-v4';
const CORE = ['./', './index.html', './style.css', './app.js', './config.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CORE)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  // Firebase handles its own offline caching via IndexedDB — don't intercept
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('identitytoolkit.googleapis.com') ||
    url.includes('securetoken.googleapis.com') ||
    url.includes('firebaseapp.com/__/auth')
  ) return;

  // Cache-first for fonts and Firebase SDK (large, versioned, stable)
  if (
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com') ||
    url.includes('gstatic.com/firebasejs')
  ) {
    e.respondWith(
      caches.open(CACHE).then(cache =>
        cache.match(e.request).then(hit =>
          hit || fetch(e.request).then(res => { cache.put(e.request, res.clone()); return res; })
        )
      )
    );
    return;
  }

  // Cache-first for local app shell only
  if (url.startsWith(self.location.origin)) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request))
    );
  }
});
