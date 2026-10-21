// クラウド版の中間サーバー（Cloudflare Workers）。仕様書 spec/cloud.md 10 章
//
// 画面（web/dist）は静的アセットとして配る（wrangler.jsonc の assets）。ここに来るのは、
// run_worker_first に書いたパス（/h/・/auth/・/me・/pair/・/healthz）だけ（登録の確認画面 /pair?code= は画面が出す）。
import { handleAuth } from './auth';
import { handleMe } from './me';
import { recordHttp } from './metrics';
import { handlePairing } from './pairing';
import { handleHostRelay } from './relay';

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    // dev（ローカル）・staging・production
    CLOUD_ENV: string;
    // OAuth のクライアント（secret。ローカルは .dev.vars）。ないプロバイダではログインできない
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    DISCORD_CLIENT_ID?: string;
    DISCORD_CLIENT_SECRET?: string;
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    // トンネルの作成・削除（#159）。API トークン・アカウント・ゾーンは secret、ドメインと接頭辞は vars。
    // どれかがなければ、トンネルは作らない（/pair/tunnel は 503）
    CF_API_TOKEN?: string;
    CF_ACCOUNT_ID?: string;
    CF_ZONE_ID?: string;
    TUNNEL_DOMAIN?: string;
    TUNNEL_PREFIX?: string;
    // HTTP の計測（#163）。なければ書かない
    METRICS?: AnalyticsEngineDataset;
}

export default {
    async fetch(request, env): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === '/healthz') {
            return withSecurityHeaders(await healthz(env), path);
        }
        // 答えた・中継した HTTP の数値を書く（#163）。途中で例外になったものは 500 として数える
        const startedAt = Date.now();
        let response: Response | undefined;
        try {
            response = withSecurityHeaders(await route(request, env, path), path);
            return response;
        } finally {
            recordHttp(env, request, response ?? new Response(null, { status: 500 }), startedAt);
        }
    },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, path: string): Promise<Response> {
    // ホストへの中継（#160）
    if (path.startsWith('/h/')) {
        return handleHostRelay(request, env, path);
    }
    if (path.startsWith('/auth/')) {
        return handleAuth(request, env, path);
    }
    if (path === '/me' || path.startsWith('/me/')) {
        return handleMe(request, env, path);
    }
    if (path.startsWith('/pair/')) {
        return handlePairing(request, env, path);
    }
    return new Response('Not found', { status: 404 });
}

// Worker が答える応答に共通で付けるヘッダー（#166）。画面（静的アセット）は web/public/_headers で付ける。
// アカウント・登録・ログインの返事はキャッシュさせない。WebSocket（101）はそのまま
export function withSecurityHeaders(response: Response, path: string): Response {
    if (response.status === 101) {
        return response;
    }
    const set = (headers: Headers) => {
        headers.set('X-Frame-Options', 'DENY');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
        if (!path.startsWith('/h/')) {
            // Worker が作る返事は JSON かリダイレクトだけ。何も読み込ませない
            headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        }
        if (path.startsWith('/me') || path.startsWith('/pair/') || path.startsWith('/auth/')) {
            headers.set('Cache-Control', 'no-store');
        }
    };
    try {
        set(response.headers);
        return response;
    } catch {
        // ヘッダーを変えられない応答（fetch の返事など）は作り直す
        const copy = new Response(response.body, response);
        set(copy.headers);
        return copy;
    }
}

// 生きているか。DB に届くかも見る（届かなければ 503）
async function healthz(env: Env): Promise<Response> {
    try {
        await env.DB.prepare('SELECT 1').first();
    } catch {
        return Response.json({ ok: false, env: env.CLOUD_ENV, db: false }, { status: 503 });
    }
    return Response.json({ ok: true, env: env.CLOUD_ENV, db: true });
}
