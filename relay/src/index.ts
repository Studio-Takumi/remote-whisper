// クラウド版の中間サーバー（Cloudflare Workers）。仕様書 spec/cloud.md 10 章
//
// 画面（web/dist）は静的アセットとして配る（wrangler.jsonc の assets）。ここに来るのは、
// run_worker_first に書いたパス（/h/・/auth/・/me・/pair/・/healthz）だけ（登録の確認画面 /pair?code= は画面が出す）。
// 中継（#160）は、その Issue で足す
import { handleAuth } from './auth';
import { handleMe } from './me';
import { handlePairing } from './pairing';

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
}

export default {
    async fetch(request, env): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === '/healthz') {
            return healthz(env);
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
    },
} satisfies ExportedHandler<Env>;

// 生きているか。DB に届くかも見る（届かなければ 503）
async function healthz(env: Env): Promise<Response> {
    try {
        await env.DB.prepare('SELECT 1').first();
    } catch {
        return Response.json({ ok: false, env: env.CLOUD_ENV, db: false }, { status: 503 });
    }
    return Response.json({ ok: true, env: env.CLOUD_ENV, db: true });
}
