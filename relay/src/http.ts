// HTTP の小さな道具（Cookie・Origin の確認・乱数・ハッシュ）

// ログインセッションの Cookie。__Host- 接頭辞で、Secure・Path=/・Domain なしを強制する
export const SESSION_COOKIE = '__Host-rw_session';

export function json(body: unknown, status = 200, headers: HeadersInit = {}): Response {
    return Response.json(body, { status, headers });
}

export function error(status: number, detail: string): Response {
    return json({ detail }, status);
}

export function getCookie(request: Request, name: string): string | null {
    const header = request.headers.get('Cookie');
    if (!header) {
        return null;
    }
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=');
        if (key === name) {
            return rest.join('=');
        }
    }
    return null;
}

export function sessionCookie(token: string, maxAgeSec: number): string {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export function clearSessionCookie(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 状態を変えるリクエストが、同じオリジンの画面から来たか（CSRF の対策。spec/cloud.md 10.7）
export function sameOrigin(request: Request): boolean {
    const origin = request.headers.get('Origin');
    return origin !== null && origin === new URL(request.url).origin;
}

export function randomToken(bytes = 32): string {
    const buf = new Uint8Array(bytes);
    crypto.getRandomValues(buf);
    return base64url(buf);
}

export function base64url(buf: ArrayBuffer | Uint8Array): string {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) {
        s += String.fromCharCode(b);
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text: string): Promise<string> {
    return base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// ログインのあとに戻ってよいパスか（同じオリジンのパスだけ。//evil.example などを弾く）。
// ブラウザは URL の中のタブ・改行を読み飛ばす（/\t/evil.example は //evil.example になる）ので、
// 制御文字を弾いたうえで、URL として読んでもオリジンが変わらないことを確かめる。
// 返すのは確かめた元の値（. や .. を畳んだ値は //evil.example になることがあるので返さない）。
// 畳んだパスが // で始まるものも、念のため弾く
export function safeReturnTo(value: string | null): string {
    // oxlint-disable-next-line no-control-regex -- 制御文字を弾くための正規表現
    if (!value || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) {
        return '/';
    }
    const base = 'https://return.invalid';
    try {
        const url = new URL(value, base);
        return url.origin === base && !url.pathname.startsWith('//') ? value : '/';
    } catch {
        return '/';
    }
}

// 本文を maxBytes まで読む。超えたら null。Content-Length がなくても（chunked でも）、超えたところで読むのをやめる。
// ログインなしで呼べる口（/pair/*）や、小さな JSON を受ける口（recordingMetrics・CSP の報告）で使う
export async function readLimited(request: Request, maxBytes: number): Promise<Uint8Array | null> {
    if (Number(request.headers.get('Content-Length') ?? '0') > maxBytes) {
        return null;
    }
    if (!request.body) {
        return new Uint8Array(0);
    }
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        total += value.length;
        if (total > maxBytes) {
            await reader.cancel();
            return null;
        }
        chunks.push(value);
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
    }
    return all;
}
