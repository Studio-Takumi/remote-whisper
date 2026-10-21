// ホストへの中継（#160。spec/cloud.md 10.3・10.5）
//
// /h/<hostId>/api/... と /h/<hostId>/ws を、そのホストのトンネル（hosts.tunnel_hostname）へ転送する。
// - ログインしていて、そのホストの持ち主であることを確かめる（他人のホスト・解除したホストには届かない）
// - 状態を変えるリクエストと WebSocket は、Origin が自分のオリジンのときだけ（兄弟のサブドメインの CSRF 対策）
// - ホストごとの中継の鍵で「ユーザー ID・ホスト ID・時刻・メソッド・パス」に HMAC-SHA256 の署名を付ける（X-RW-Relay）。
//   ホストはトンネル専用の 8001 番でこれを確かめる
// - WebSocket はメッセージを受けずに素通しにする（無料プランの CPU 時間に収めるため）。つなぐときだけ確かめて、
//   fetch の応答（101）をそのまま返す
import { currentUser } from './auth';
import { base64url, error, sameOrigin } from './http';
import type { Env } from './index';

export const RELAY_HEADER = 'X-RW-Relay';
const HOST_PATH = /^\/h\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\/.*)$/;
// Worker が作ったトンネルの公開ホスト名だけに送る（DB の値が壊れていても、ほかへは送らない）
// （rwt-<12 桁>、staging などは rwt-dev-<12 桁> のように環境の名前が入る。#159。
// 頭 12 桁がほかのホストと重なったときは 32 桁。#166）
const TUNNEL_HOSTNAME = /^rwt-(?:[a-z]+-)?(?:[0-9a-f]{12}|[0-9a-f]{32})\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// ホストに渡さないヘッダー（ブラウザの資格情報・Worker の署名と同じ名前・Cloudflare のもの・1xx を返させるもの・
// 接続元を名乗るもの（uvicorn は 127.0.0.1 からの X-Forwarded-For を信じるため））
const DROPPED = [
    'cookie',
    'authorization',
    'x-rw-relay',
    'x-rw-host',
    'expect',
    'host',
    'forwarded',
    'x-real-ip',
    'true-client-ip',
    'cdn-loop',
];
const DROPPED_PREFIXES = ['cf-', 'x-forwarded-'];
// ホストの応答から落とすヘッダー（このオリジンの Cookie・リダイレクト・CORS・サイトのデータの消去・Service Worker の範囲）
const DROPPED_RESPONSE = ['set-cookie', 'refresh', 'clear-site-data', 'service-worker-allowed'];

function base64urlDecode(text: string): Uint8Array {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// 署名の対象: 6 行を LF でつないだもの（末尾に改行なし）。ホストの server/src/remote_whisper/ と同じ組み立て方
export function relayCanonical(userId: string, hostId: string, ts: number, method: string, path: string): string {
    return ['v1', userId, hostId, String(ts), method.toUpperCase(), path].join('\n');
}

// X-RW-Relay の値。key は中継の鍵（base64url）をデコードしたバイト列
export async function signRelay(
    relayKey: string,
    userId: string,
    hostId: string,
    ts: number,
    method: string,
    path: string,
): Promise<string> {
    const key = await crypto.subtle.importKey(
        'raw',
        base64urlDecode(relayKey),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(relayCanonical(userId, hostId, ts, method, path)),
    );
    return `v1;user=${userId};host=${hostId};ts=${ts};sig=${base64url(sig)}`;
}

export async function handleHostRelay(request: Request, env: Env, path: string): Promise<Response> {
    const m = HOST_PATH.exec(path);
    // 中継するのはホストの API と WebSocket だけ（ホストの画面やほかのパスは出さない）。
    // エンコードした / と \（%2F・%5C）は URL の正規化で畳まれず、ホストでデコードされて /api/../ になるので通さない
    if (!m || !(m[2].startsWith('/api/') || m[2] === '/ws') || /%2f|%5c/i.test(m[2])) {
        return error(404, 'Not found');
    }
    const [, hostId, hostPath] = m;
    const user = await currentUser(request, env);
    if (!user) {
        return error(401, 'ログインしてください');
    }
    const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if ((websocket || !['GET', 'HEAD'].includes(request.method)) && !sameOrigin(request)) {
        return error(403, 'Forbidden');
    }
    const host = await env.DB.prepare('SELECT relay_key, tunnel_hostname FROM hosts WHERE id = ? AND user_id = ?')
        .bind(hostId, user.userId)
        .first<{ relay_key: string | null; tunnel_hostname: string | null }>();
    if (!host) {
        // 他人のホスト・解除したホスト。あるかないかも教えない
        return error(403, 'このホストにはつなげません');
    }
    if (!host.relay_key || !host.tunnel_hostname || !TUNNEL_HOSTNAME.test(host.tunnel_hostname)) {
        return error(503, 'ホストのトンネルがまだできていません');
    }
    const search = new URL(request.url).search;
    const target = `https://${host.tunnel_hostname}${hostPath}${search}`;
    const headers = new Headers();
    for (const [name, value] of request.headers) {
        const lower = name.toLowerCase();
        if (!DROPPED.includes(lower) && !DROPPED_PREFIXES.some((p) => lower.startsWith(p))) {
            headers.set(name, value);
        }
    }
    const ts = Math.floor(Date.now() / 1000);
    try {
        headers.set(
            RELAY_HEADER,
            await signRelay(host.relay_key, user.userId, hostId, ts, request.method, hostPath + search),
        );
    } catch {
        // 中継の鍵が壊れている（base64url として読めない）
        return error(503, 'ホストの中継の鍵が読めません。登録し直してください');
    }
    const init: RequestInit = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) {
        init.body = request.body;
    }
    let res: Response;
    try {
        res = await fetch(target, init);
    } catch {
        return error(502, 'ホストにつながりません（PC が起動しているか確かめてください）');
    }
    const headersOut = safeResponseHeaders(res);
    if (res.status === 101 && res.webSocket) {
        // WebSocket は素通し。ヘッダーだけ同じように落として作り直す
        return new Response(null, { status: 101, webSocket: res.webSocket, headers: headersOut });
    }
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: headersOut });
}

// ホストがこのオリジンに Cookie を置いたり、ほかへ飛ばしたり、サイトのデータを消したりできないようにする。
// リダイレクトはホストの中の話なので Location も落とす。中身の型をブラウザに推測させない
function safeResponseHeaders(res: Response): Headers {
    const out = new Headers();
    for (const [name, value] of res.headers) {
        const lower = name.toLowerCase();
        if (DROPPED_RESPONSE.includes(lower) || lower.startsWith('access-control-') || lower === 'location') {
            continue;
        }
        out.append(name, value);
    }
    out.set('X-Content-Type-Options', 'nosniff');
    return out;
}
