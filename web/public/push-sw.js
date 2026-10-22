// 最終要約ができたときの通知（Web Push。#245・spec/ui.md 8 章）。vite-plugin-pwa が作る service worker に
// importScripts で読み込む（更新の知らせ（PwaUpdater）とオフラインのキャッシュの動きは変えない）。
// 届く中身は { title, body, url, session } だけ（要約の本文は載せない）

// 画面が知らせてきた、今開いている画面のパス（クライアントの ID ごと）。画面は URL を history で
// 書き換えるので、client.url は開いたときのままのことがある（push.ts の reportView）
const views = new Map();

self.addEventListener('message', (event) => {
    const data = event.data;
    if (data && data.type === 'rw-view' && typeof data.path === 'string' && event.source) {
        views.set(event.source.id, data.path);
    }
});

// そのセッションを画面に出しているクライアント（見えているタブ・PWA）があれば、通知は出さない
async function showingSession(url) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    return windows.some((c) => c.visibilityState === 'visible' && (views.get(c.id) ?? new URL(c.url).pathname) === url);
}

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        return;
    }
    const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/';
    event.waitUntil(
        showingSession(url).then((showing) => {
            if (showing) {
                return undefined;
            }
            return self.registration.showNotification(data.title || '最終要約ができました', {
                body: data.body || '',
                // 同じセッションの通知は 1 つにまとめる
                tag: data.session ? `summary-${data.session}` : undefined,
                icon: '/pwa-192.png',
                badge: '/pwa-192.png',
                data: { url },
            });
        }),
    );
});

// 通知を押したら、そのセッションの画面を開く。開いているタブ（PWA）があれば、そこで開く
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/';
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
            const own = windows.find((c) => new URL(c.url).origin === self.location.origin);
            if (own) {
                return own.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : undefined));
            }
            return self.clients.openWindow(url);
        }),
    );
});
