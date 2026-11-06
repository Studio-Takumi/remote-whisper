// CSP の違反の報告（#253。spec/cloud.md 10.7）。画面の CSP（web/public/_headers）の report-uri と report-to が送ってくる。
// ログインなしで来る（ブラウザが Cookie を付けずに送ることがある）ので、本文の大きさと回数を制限し、
// 中身は数えるのに要るものだけを Analytics Engine に書く
//
// - 受ける形: report-uri の `{"csp-report": {...}}`（application/csp-report）と、
//   Reporting API の `[{"type": "csp-violation", "body": {...}}]`（application/reports+json）
// - 書くもの: 違反したディレクティブの名前・強制か報告だけか・画面のパス（ID は伏せる）・読み込もうとしたもの
//   （inline・eval などの種類か、オリジンとパス。ID は伏せる）・ブラウザと OS の大まかな種類・同じ報告の件数
// - 書かないもの: クエリ・フラグメント、IP アドレス、Cookie、スクリプトの抜粋（sample）、ポリシーの全文、
//   ファイル名・行番号、ほかのオリジンの画面からの報告
import { error, readLimited } from './http';
import type { Env } from './index';
import { browserOf, normalizePath, osOf } from './metrics';

export const CSP_REPORT_PATH = '/csp-report';
// 1 回の本文の上限。Reporting API は数件をまとめて送る（1 件はポリシーの全文を含めて 1KB ほど）
export const MAX_BODY_BYTES = 32 * 1024;
// 1 回の本文から読む報告の数。残りは捨てる
export const MAX_REPORTS = 20;
// 1 回の本文から書く行の数（同じ違反はまとめて件数にする）
export const MAX_POINTS = 5;

// 画面の URL の決まった区切り（web/src/router.ts）。ここにないものは :v か :id に伏せる
const SCREEN_SEGMENTS = new Set(['s', 'p', 'new', 'settings', 'pair', 'h', 'api', 'ws', 'assets']);
// 読み込もうとしたものが URL でないときの値（CSP3 と、古い report-uri の形）
const BLOCKED_KEYWORDS = new Set([
    'inline',
    'eval',
    'wasm-eval',
    'trusted-types-policy',
    'trusted-types-sink',
    'data',
    'blob',
    'self',
]);
const DIRECTIVE = /^[a-z][a-z-]{0,39}$/;

export type CspViolation = {
    directive: string;
    disposition: 'enforce' | 'report' | 'other';
    page: string;
    blocked: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

// 画面のパスを伏せる。router.ts の決まった区切りだけを残し、ほかは metrics.ts と同じ規則で :id・:v にする
export function screenPath(path: string): string {
    const normalized = normalizePath(path);
    const original = path.split('/').slice(1, 7);
    return normalized
        .split('/')
        .map((s, i) => (i > 0 && SCREEN_SEGMENTS.has(original[i - 1]) ? original[i - 1] : s))
        .join('/')
        .slice(0, 96);
}

// 読み込もうとしたもの。種類の言葉か、URL のオリジンとパス（同じオリジンは self）。クエリは捨てる
export function blockedOf(value: string, origin: string): string {
    const v = value.trim().toLowerCase();
    if (BLOCKED_KEYWORDS.has(v)) {
        return v;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return v === '' ? 'none' : 'other';
    }
    // data:・blob: など（中身は書かない）
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) {
        return /^[a-z][a-z0-9+.-]{0,19}:$/.test(url.protocol) ? url.protocol.slice(0, -1) : 'other';
    }
    // 同じホストの WebSocket（wss:）は、connect-src 'self' に当たるかを見たいので分けて書く
    const sameHostWs = ['ws:', 'wss:'].includes(url.protocol) && url.host === new URL(origin).host;
    const where =
        url.origin === origin ? 'self' : sameHostWs ? `self:${url.protocol.slice(0, -1)}` : url.origin.slice(0, 80);
    return `${where}${normalizePath(url.pathname)}`.slice(0, 160);
}

// 1 件の報告を、書いてよい項目だけにする。ほかのオリジンの画面の報告・形が違うものは null
export function parseViolation(report: unknown, origin: string): CspViolation | null {
    if (!isRecord(report)) {
        return null;
    }
    let body: Record<string, unknown>;
    let documentUrl: string;
    let directive: string;
    let blocked: string;
    if (isRecord(report['csp-report'])) {
        // report-uri の形
        body = report['csp-report'];
        documentUrl = str(body['document-uri']);
        // effective-directive がない古いブラウザは violated-directive の最初の語
        directive = str(body['effective-directive']) || str(body['violated-directive']).split(' ')[0];
        blocked = str(body['blocked-uri']);
    } else if (report.type === 'csp-violation' && isRecord(report.body)) {
        // Reporting API の形
        body = report.body;
        documentUrl = str(body.documentURL) || str(report.url);
        directive = str(body.effectiveDirective);
        blocked = str(body.blockedURL);
    } else {
        return null;
    }
    let page: URL;
    try {
        page = new URL(documentUrl);
    } catch {
        return null;
    }
    if (page.origin !== origin) {
        return null;
    }
    const disposition = str(body.disposition);
    return {
        directive: DIRECTIVE.test(directive) ? directive : 'other',
        disposition: disposition === 'enforce' || disposition === 'report' ? disposition : 'other',
        page: screenPath(page.pathname),
        blocked: blockedOf(blocked, origin),
    };
}

export type CspDataPoint = { blobs: string[]; doubles: number[]; indexes: string[] };

// 書く行を作る。同じ違反はまとめて件数にし、MAX_POINTS 行まで
export function cspDataPoints(violations: CspViolation[], userAgent: string): CspDataPoint[] {
    const counts = new Map<string, { v: CspViolation; n: number }>();
    for (const v of violations) {
        const key = [v.directive, v.disposition, v.page, v.blocked].join('\n');
        const entry = counts.get(key);
        if (entry) {
            entry.n++;
        } else {
            counts.set(key, { v, n: 1 });
        }
    }
    return [...counts.values()].slice(0, MAX_POINTS).map(({ v, n }) => ({
        // 1 種類 2 ディレクティブ 3 強制か報告だけか 4 画面のパス 5 読み込もうとしたもの 6 ブラウザ 7 OS
        blobs: ['csp', v.directive, v.disposition, v.page, v.blocked, browserOf(userAgent), osOf(userAgent)],
        // 1 同じ報告の件数
        doubles: [n],
        indexes: ['csp'],
    }));
}

// 接続元ごとの回数の制限（wrangler.jsonc の ratelimits。束縛がなければ制限しない＝ローカル）。
// 数えるのは Cloudflare の中で、こちらでは IP アドレスを置かない
async function allowed(request: Request, env: Env): Promise<boolean> {
    if (!env.CSP_REPORT_LIMITER) {
        return true;
    }
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    try {
        return (await env.CSP_REPORT_LIMITER.limit({ key: `csp:${ip}` })).success;
    } catch {
        // 制限を確かめられないときは受けない（数えるだけのものなので、落としても困らない）
        return false;
    }
}

// POST /csp-report。受け取れないもの（形が違う・ほかのオリジン）は黙って捨てて 204
export async function handleCspReport(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'POST') {
        return error(405, 'Method not allowed');
    }
    if (!(await allowed(request, env))) {
        return error(429, 'too many requests');
    }
    const bytes = await readLimited(request, MAX_BODY_BYTES);
    if (bytes === null) {
        return error(413, 'too large');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return new Response(null, { status: 204 });
    }
    const origin = new URL(request.url).origin;
    const reports = (Array.isArray(parsed) ? parsed : [parsed]).slice(0, MAX_REPORTS);
    const violations = reports.map((r) => parseViolation(r, origin)).filter((v): v is CspViolation => v !== null);
    try {
        for (const point of cspDataPoints(violations, request.headers.get('User-Agent') ?? '')) {
            env.METRICS?.writeDataPoint(point);
        }
    } catch (e) {
        console.warn(`failed to write a metric: ${(e as Error).message}`);
    }
    return new Response(null, { status: 204 });
}
