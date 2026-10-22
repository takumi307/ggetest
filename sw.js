/* GGE Tracker PWA + Web Push service worker */
self.addEventListener('install', (event) => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'GGE Tracker 通知';
  const options = {
    body: data.body || '攻撃可能時刻になりました。',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    tag: data.tag || data.notificationId || undefined,
    renotify: false,
    data: { url: data.url || './?tab=ready', entryId: data.entryId || null }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data && event.notification.data.url || './?tab=ready', self.registration.scope).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        const focused = await client.focus();
        if (focused && 'navigate' in focused) await focused.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
