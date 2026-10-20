// HTTP の計測（#163。spec/cloud.md 10.9）。Worker が答えた・中継した HTTP の数値だけを Analytics Engine に書く。
//
// - 書くもの: 種類・メソッド・パス（ID は :id に伏せる。クエリは書かない）・ステータス・かかった ms・本文の大きさ・
//   WebSocket をつないだか・国・ブラウザと OS の大まかな種類・ユーザー ID・ホスト ID
// - 書かないもの: IP アドレス、クエリ、Cookie などのヘッダー、本文の中身
// - 書けなくても（束縛がない・失敗した）応答は止めない
import type { Env } from './index';

// ログインしているユーザー（auth.ts の currentUser が、そのリクエストについて覚える）
const userOf = new WeakMap<Request, string>();

export function rememberUser(request: Request, userId: string) {
    userOf.set(request, userId);
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HOST_PATH = /^\/h\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

// パスの ID を伏せる。UUID と、数字や長い英数字の区切りは :id にする。区切りは 6 つまで、長さは 96 文字まで
export function normalizePath(path: string): string {
    const segments = path
        .split('/')
        .slice(1, 7)
        .map((s) => {
            const plain = s.replace(UUID, ':id');
            if (plain !== s) {
                return plain.length > 3 + 1 ? ':id' : plain;
            }
            if (/^\d+$/.test(s) || /^[A-Za-z0-9_%.-]{16,}$/.test(s)) {
                return ':id';
            }
            // 用語の削除などで本文がパスに入るものは、文字を残さない
            return /^[a-z][a-z0-9-]{0,31}$/.test(s) ? s : ':v';
        });
    return `/${segments.join('/')}`.slice(0, 96);
}

export function browserOf(ua: string): string {
    if (/Edg\//.test(ua)) return 'edge';
    if (/OPR\//.test(ua)) return 'opera';
    if (/Firefox\//.test(ua)) return 'firefox';
    if (/Chrome\//.test(ua)) return 'chrome';
    if (/Safari\//.test(ua)) return 'safari';
    return 'other';
}

export function osOf(ua: string): string {
    if (/Windows/.test(ua)) return 'windows';
    if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macos';
    if (/Android/.test(ua)) return 'android';
    if (/Linux/.test(ua)) return 'linux';
    return 'other';
}

// どの仕事か（集計で分けるため）
function kindOf(path: string): string {
    if (path.startsWith('/h/')) return 'relay';
    if (path.startsWith('/auth/')) return 'auth';
    if (path.startsWith('/pair/')) return 'pair';
    if (path === '/me' || path.startsWith('/me/')) return 'me';
    return 'other';
}

function size(headers: Headers): number {
    const n = Number(headers.get('Content-Length') ?? '');
    return Number.isFinite(n) && n >= 0 ? n : -1;
}

export type HttpDataPoint = { blobs: string[]; doubles: number[]; indexes: string[] };

// 書く 1 行を作る（許可した項目だけ）。blobs と doubles の並びは docs の SQL と合わせる
export function httpDataPoint(request: Request, response: Response, ms: number): HttpDataPoint {
    const url = new URL(request.url);
    const ua = request.headers.get('User-Agent') ?? '';
    const cf = (request as Request & { cf?: { country?: unknown } }).cf;
    const country = typeof cf?.country === 'string' && /^[A-Z]{2}$/.test(cf.country) ? cf.country : 'XX';
    const websocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    const userId = userOf.get(request) ?? '';
    const hostId = HOST_PATH.exec(url.pathname)?.[1] ?? '';
    return {
        // 1 種類 2 メソッド 3 パス 4 国 5 ブラウザ 6 OS 7 ユーザー ID 8 ホスト ID 9 WebSocket か
        blobs: [
            kindOf(url.pathname),
            /^[A-Z]{3,7}$/.test(request.method) ? request.method : 'OTHER',
            normalizePath(url.pathname),
            country,
            browserOf(ua),
            osOf(ua),
            userId,
            hostId,
            websocket ? 'ws' : 'http',
        ],
        // 1 ステータス 2 かかった ms 3 リクエストの本文の大きさ 4 応答の本文の大きさ（分からなければ -1）
        doubles: [response.status, Math.max(0, Math.round(ms)), size(request.headers), size(response.headers)],
        // サンプリングの単位（ユーザーごと。ログインしていなければ種類）
        indexes: [userId || kindOf(url.pathname)],
    };
}

export function recordHttp(env: Env, request: Request, response: Response, startedAt: number) {
    try {
        env.METRICS?.writeDataPoint(httpDataPoint(request, response, Date.now() - startedAt));
    } catch (e) {
        console.warn(`failed to write a metric: ${(e as Error).message}`);
    }
}
