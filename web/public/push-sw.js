// 最終要約ができたときの通知（Web Push。#245・spec/flows.md 6.14）。vite-plugin-pwa が作る service worker に
// importScripts で読み込む（更新の知らせ（PwaUpdater）とオフラインのキャッシュの動きは変えない）。
// 届く中身は { title, body, url, session } だけ（要約の本文は載せない）

// 開いている画面に「今どの画面を出しているか」を聞く。画面は URL を history で書き換えるので、client.url は
// 開いたときのままのことがある（push.ts の answerViewQueries が答える）。答えなければ（凍結されたタブなど）
// 出していないものとして扱う
function askView(client) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        const timer = setTimeout(() => resolve(null), 1000);
        channel.port1.onmessage = (event) => {
            clearTimeout(timer);
            resolve(event.data);
        };
        try {
            client.postMessage({ type: 'rw-where' }, [channel.port2]);
        } catch {
            clearTimeout(timer);
            resolve(null);
        }
    });
}

// そのセッションを画面に出しているクライアント（見えているタブ・PWA）があるか
async function showingSession(url) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const views = await Promise.all(windows.filter((c) => c.visibilityState === 'visible').map(askView));
    return views.some((v) => v && v.visible && v.path === url);
}

// 画面の中のパスだけを開く（//example.com のようなほかのサイトは開かない）
function safePath(url) {
    return typeof url === 'string' && url.startsWith('/') && !url.startsWith('//') ? url : '/';
}

self.addEventListener('push', (event) => {
    let data = {};
    try {
        data = event.data ? event.data.json() : {};
    } catch {
        data = {};
    }
    const url = safePath(data.url);
    const tag = data.session ? `summary-${data.session}` : 'summary';
    event.waitUntil(
        showingSession(url).then(async (showing) => {
            // ブラウザは、通知を出さない push が続くと購読を取り消すことがある（Safari）・代わりの通知を出す
            // （Chrome）ので、そのセッションを出しているときも通知は作り、すぐ閉じる
            await self.registration.showNotification(data.title || '最終要約ができました', {
                body: data.body || '',
                // 同じセッションの通知は 1 つにまとめる
                tag,
                icon: '/pwa-192.png',
                badge: '/pwa-192.png',
                silent: showing,
                data: { url },
            });
            if (showing) {
                const shown = await self.registration.getNotifications({ tag });
                shown.forEach((n) => n.close());
            }
        }),
    );
});

// 通知を押したら、そのセッションの画面を開く。開いているタブ（PWA）があれば、そこで開く
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = safePath(event.notification.data && event.notification.data.url);
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
            const own = windows.find((c) => new URL(c.url).origin === self.location.origin);
            if (own) {
                try {
                    const focused = await own.focus();
                    // まだこの service worker が制御していないタブは navigate できないので、そのときは新しく開く
                    if (focused && 'navigate' in focused && (await focused.navigate(url))) {
                        return undefined;
                    }
                } catch {
                    // 下で新しく開く
                }
            }
            return self.clients.openWindow(url);
        }),
    );
});
