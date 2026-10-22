// 最終要約ができたときの通知（Web Push。#245・spec/ui.md 8 章）。端末ごとの設定で、既定はオフ。
// オンにしたときにだけブラウザの許可を求め、購読をホストに送る（POST /api/push/subscriptions）
import { api } from '@/api';

const ENABLED_KEY = 'rw.pushNotify';

export type PushSupport =
    | 'ok'
    // HTTPS（安全なコンテキスト）でない。ダイレクト版を http で開いているときなど
    | 'insecure'
    // ブラウザが Web Push に対応していない（iPhone はホーム画面に追加した PWA だけ）
    | 'unsupported'
    // 通知を許可しなかった（ブラウザの設定で許可し直すまで求められない）
    | 'denied';

type PushEnv = {
    isSecureContext: boolean;
    hasServiceWorker: boolean;
    hasPushManager: boolean;
    hasNotification: boolean;
    permission: NotificationPermission | null;
};

function currentEnv(): PushEnv {
    const hasNotification = typeof Notification !== 'undefined';
    return {
        isSecureContext: typeof window !== 'undefined' && window.isSecureContext,
        hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
        hasPushManager: typeof window !== 'undefined' && 'PushManager' in window,
        hasNotification,
        permission: hasNotification ? Notification.permission : null,
    };
}

export function pushSupport(env: PushEnv = currentEnv()): PushSupport {
    if (!env.isSecureContext) {
        return 'insecure';
    }
    if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) {
        return 'unsupported';
    }
    return env.permission === 'denied' ? 'denied' : 'ok';
}

export function pushSupportMessage(support: PushSupport) {
    switch (support) {
        case 'insecure':
            return 'HTTPS で開いているときだけ使えます（http では使えません）';
        case 'unsupported':
            return 'このブラウザでは使えません。iPhone はホーム画面に追加したアプリ（iOS 16.4 以降）でだけ使えます';
        case 'denied':
            return '通知が許可されていません。ブラウザの設定で、このサイトの通知を許可してください';
        default:
            return '';
    }
}

// VAPID の公開鍵（base64url）を applicationServerKey に渡す形にする
export function keyBytes(base64url: string) {
    const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (base64url.length % 4)) % 4);
    const raw = atob(padded);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
}

export function pushEnabled() {
    try {
        return localStorage.getItem(ENABLED_KEY) === '1';
    } catch {
        return false;
    }
}

function remember(on: boolean) {
    try {
        if (on) {
            localStorage.setItem(ENABLED_KEY, '1');
        } else {
            localStorage.removeItem(ENABLED_KEY);
        }
    } catch {
        // 保存できなくても、購読そのものはホストにある
    }
}

// オンにする。許可を求め、購読してホストに送る。できなければ理由を投げる
export async function enablePush() {
    const support = pushSupport();
    if (support !== 'ok') {
        throw new Error(pushSupportMessage(support));
    }
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
        throw new Error(pushSupportMessage('denied'));
    }
    const registration = await navigator.serviceWorker.ready;
    const { publicKey } = await api.get<{ publicKey: string }>('/api/push/key');
    let subscription = await registration.pushManager.getSubscription();
    // 前に別の鍵（ホストを入れ直した・別のホスト）で購読していたら、作り直す
    const current = subscription?.options.applicationServerKey;
    if (subscription && current && !sameKey(new Uint8Array(current), keyBytes(publicKey))) {
        await subscription.unsubscribe();
        subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: keyBytes(publicKey),
    });
    await api.post('/api/push/subscriptions', subscription.toJSON());
    remember(true);
}

// オフにする。購読をやめ、ホストからも消す
export async function disablePush() {
    remember(false);
    if (pushSupport() === 'insecure' || !('serviceWorker' in navigator)) {
        return;
    }
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
        return;
    }
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await api.delete(`/api/push/subscriptions?endpoint=${encodeURIComponent(endpoint)}`);
}

// ログアウト・退会の前に呼ぶ（クラウド版。同じブラウザでほかのアカウントがログインしても、前のアカウントの
// 通知が届かないように）。この端末の購読をやめ、ホストからも消す。失敗しても止めない
// （購読をやめておけば、ホストが送ったときに push サービスが 410 を返し、ホストが消す）
export async function stopPushOnSignOut() {
    if (!pushEnabled()) {
        return;
    }
    await disablePush().catch(() => undefined);
}

// オンのままの端末では、開くたびに購読をホストに送り直す（ホストの鍵を作り直した・購読が消えたときのため）
export async function resyncPush() {
    if (!pushEnabled() || pushSupport() !== 'ok' || Notification.permission !== 'granted') {
        return;
    }
    try {
        await enablePush();
    } catch {
        // ホストにつながっていないときなど。次に開いたときに送り直す
    }
}

// service worker（push-sw.js）が「今どの画面を出しているか」を聞いてきたら答える。そのセッションを
// 出していれば通知を出さない。画面は URL を history で書き換えるので、client.url では分からない。
// 止まっている（裏に回って凍結された）タブは答えないので、出していないものとして扱われる
export function answerViewQueries() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
        return;
    }
    navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
        if (event.data?.type === 'rw-where' && event.ports[0]) {
            event.ports[0].postMessage({ path: location.pathname, visible: document.visibilityState === 'visible' });
        }
    });
}

function sameKey(a: Uint8Array, b: Uint8Array) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
}
