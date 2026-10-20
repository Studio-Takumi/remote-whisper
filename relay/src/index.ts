// クラウド版の中間サーバー（Cloudflare Workers）。仕様書 spec/cloud.md 10 章
//
// 画面（web/dist）は静的アセットとして配る（wrangler.jsonc の assets）。ここに来るのは、
// run_worker_first に書いたパス（/h/・/auth/・/me/・/pair・/healthz）だけ。
// ログイン（#155）・ホストの登録（#157）・中継（#160）は、それぞれの Issue で足す

export interface Env {
    DB: D1Database;
    ASSETS: Fetcher;
    // dev（ローカル）・staging・production
    CLOUD_ENV: string;
}

export default {
    async fetch(request, env): Promise<Response> {
        const url = new URL(request.url);
        if (url.pathname === '/healthz') {
            return healthz(env);
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
