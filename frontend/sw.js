// Service Worker para Notificaciones Web Push en segundo plano

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
    if (!event.data) return;

    let payload;
    try {
        payload = event.data.json();
    } catch (e) {
        payload = { title: 'Nuevo mensaje', body: event.data.text() };
    }

    const title = payload.title || 'Chat con Hilos';
    const options = {
        body: payload.body || 'Tenés un nuevo mensaje.',
        icon: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
        badge: 'https://cdn-icons-png.flaticon.com/512/1041/1041916.png',
        vibrate: [150, 50, 150],
        data: {
            url: payload.url || '/'
        }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // Si ya hay una ventana abierta del chat, la enfocamos
            for (const client of clientList) {
                if ('focus' in client) {
                    return client.focus();
                }
            }
            // Si no hay ventana abierta, abrimos una nueva
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
