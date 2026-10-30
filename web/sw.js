/* 极简离线缓存：让加到主屏幕的 App 断网也能打开界面。
   接口请求一律走网络，不缓存 —— 缓存一份文件列表比缓存一份错误的文件列表更危险。 */

const CACHE = 'fcloud-v4';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/ai.js',
  '/manifest.webmanifest',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // 接口永远走网络
  if (url.pathname.startsWith('/api/')) return;

  // 页面：网络优先，断网回退到缓存的外壳
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // 静态资源：缓存优先
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy));
      return res;
    }))
  );
});
