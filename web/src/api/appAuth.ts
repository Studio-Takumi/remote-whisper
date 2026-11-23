// iOS アプリの中のクラウド版のログイン（#441。spec/mobile.md 11.10・cloud.md 10.7）。
// アプリの中（同梱でも server.url でも）でクラウド版につないでいるときだけ、中間サーバーへの API にアプリのトークン
// （Authorization: Bearer）を付け、ヘッダーを付けられない WebSocket と音声には短い期限のチケット（?rw_ticket=）を付ける。
// ブラウザ版・セルフホスト版では何もしない（Cookie のログインのまま。init もそのまま返す）
import { isDemo } from '@/api/demo';
import { endpoint, getHostId, isCloud, meUrl } from '@/api/endpoint';
import { isNativeApp, loadAppAuthBridge } from '@/features/native/nativePlatform';

export const appAuthActive = isNativeApp() && isCloud && !isDemo;

// トークンを使う中間サーバーのオリジン。同梱していれば接続先、server.url なら画面のオリジン（中間サーバーそのもの）
export function relayOrigin(base = endpoint.base, here: { origin: string } = location) {
    return base || here.origin;
}

// 使えるアクセストークン（アプリが期限の前に更新する）。ログインしていない・アプリの中でないときは null
export async function appAccessToken(): Promise<string | null> {
    if (!appAuthActive) {
        return null;
    }
    try {
        return await (await loadAppAuthBridge()).appAuthToken(relayOrigin());
    } catch {
        return null;
    }
}

export function addBearer(init: RequestInit, token: string | null): RequestInit {
    if (!token) {
        return init;
    }
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return { ...init, headers };
}

// fetch の init にトークンを足す。アプリの中のクラウド版でなければ、受け取った init をそのまま（同期で）返す
export function withAppAuth(init: RequestInit = {}): RequestInit | Promise<RequestInit> {
    if (!appAuthActive) {
        return init;
    }
    return appAccessToken().then((token) => addBearer(init, token));
}

type Ticket = { ticket: string; expiresAt: number };
export type TicketKind = 'ws' | 'media';

// 音声のチケットは期限（1 時間）まで使い回す。残りがこれより短ければ作り直す
const MEDIA_REUSE_MARGIN_MS = 10 * 60 * 1000;
const mediaTickets = new Map<string, Ticket>();

async function issueTicket(hostId: string, kind: TicketKind, path: string): Promise<Ticket | null> {
    const token = await appAccessToken();
    if (!token) {
        return null;
    }
    try {
        const res = await fetch(
            meUrl('/tickets'),
            addBearer(
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ hostId, kind, path }),
                },
                token,
            ),
        );
        return res.ok ? ((await res.json()) as Ticket) : null;
    } catch {
        return null;
    }
}

export function withTicket(url: string, ticket: string) {
    return `${url}${url.includes('?') ? '&' : '?'}rw_ticket=${encodeURIComponent(ticket)}`;
}

// WebSocket の URL にチケット（一度だけ・60 秒）を付ける。作れなければ元の URL（中間サーバーが 401 で断り、つなぎ直しを待つ）
export async function appSocketUrl(url: string, hostId = getHostId()): Promise<string> {
    if (!appAuthActive || !hostId) {
        return url;
    }
    const t = await issueTicket(hostId, 'ws', '/ws');
    return t ? withTicket(url, t.ticket) : url;
}

// 中継の音声の URL（…/h/<hostId>/api/projects/<pid>/sessions/<sid>/recording?…）から、ホストとパスを取り出す
export function mediaTarget(src: string, here = location.href): { hostId: string; path: string } | null {
    const m = /^\/h\/([^/]+)(\/api\/projects\/[^/]+\/sessions\/[^/]+\/recording)$/.exec(new URL(src, here).pathname);
    return m ? { hostId: decodeURIComponent(m[1]), path: m[2] } : null;
}

// 音声の URL にチケット（そのパスだけ・1 時間）を付ける。作れなければ元の URL（トークンがなければ WebView の Cookie で読む。
// どちらもなければ中間サーバーが 401 で断り、再生バーは読み込めなかったときと同じ扱いになる）
export async function appMediaUrl(src: string, now = Date.now()): Promise<string> {
    const target = appAuthActive ? mediaTarget(src) : null;
    if (!target) {
        return src;
    }
    const key = `${target.hostId}${target.path}`;
    let t = mediaTickets.get(key);
    if (!t || t.expiresAt - MEDIA_REUSE_MARGIN_MS <= now) {
        t = (await issueTicket(target.hostId, 'media', target.path)) ?? undefined;
        if (!t) {
            return src;
        }
        mediaTickets.set(key, t);
    }
    return withTicket(src, t.ticket);
}

// --- ログイン・ログアウト（アプリの中でだけ呼ぶ） ---

// システムのログイン画面でログインする。やめたら code が 'canceled' の Error
export async function appLogin(provider: string) {
    await (await loadAppAuthBridge()).appAuthLogin(relayOrigin(), provider);
}

export function isCanceled(e: unknown) {
    return (e as { code?: string }).code === 'canceled';
}

// この端末をログアウトする（中間サーバーのこの端末も消す）
export async function appLogout() {
    if (!appAuthActive) {
        return;
    }
    mediaTickets.clear();
    await (await loadAppAuthBridge()).appAuthLogout(relayOrigin());
}

// アプリの中のトークンだけを消す（すべての端末からログアウト・退会のあと）
export async function appForget() {
    if (!appAuthActive) {
        return;
    }
    mediaTickets.clear();
    await (await loadAppAuthBridge()).appAuthForget(relayOrigin());
}
