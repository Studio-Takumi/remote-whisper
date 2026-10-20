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
const TUNNEL_HOSTNAME = /^rwt-[0-9a-f]{12}\.[a-z0-9-]+(\.[a-z0-9-]+)+$/;
// ホストに渡さないヘッダー（ブラウザの資格情報・Worker の署名と同じ名前・Cloudflare のもの・1xx を返させるもの）
const DROPPED = ['cookie', 'authorization', 'x-rw-relay', 'x-rw-host', 'expect', 'host'];

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
    // 中継するのはホストの API と WebSocket だけ（ホストの画面やほかのパスは出さない）
    if (!m || !(m[2].startsWith('/api/') || m[2] === '/ws')) {
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
        if (!DROPPED.includes(lower) && !lower.startsWith('cf-')) {
            headers.set(name, value);
        }
    }
    const ts = Math.floor(Date.now() / 1000);
    headers.set(
        RELAY_HEADER,
        await signRelay(host.relay_key, user.userId, hostId, ts, request.method, hostPath + search),
    );
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
    if (websocket) {
        // 101 と webSocket をそのまま返す（素通し）
        return res;
    }
    // ホストがこのオリジンに Cookie を置けないようにする。リダイレクトはホストの中の話なので、そのまま返さない
    const out = new Response(res.body, res);
    out.headers.delete('Set-Cookie');
    if (res.status >= 300 && res.status < 400) {
        out.headers.delete('Location');
    }
    return out;
}
