// 自分のアカウント（#155）: /me（ログインしているか・ログイン手段の一覧）、ログイン手段を外す、退会
import { currentUser } from './auth';
import { clearSessionCookie, error, json, sameOrigin } from './http';
import type { Env } from './index';
import { PROVIDERS } from './providers';
import { type HostTunnel, deleteTunnel, deleteUserTunnels } from './tunnel';

export async function handleMe(request: Request, env: Env, path: string): Promise<Response> {
    const user = await currentUser(request, env);
    if (!user) {
        return error(401, 'ログインしてください');
    }
    // 状態を変えるものは、同じオリジンの画面からだけ（CSRF の対策）
    if (request.method !== 'GET' && !sameOrigin(request)) {
        return error(403, 'Forbidden');
    }
    if (path === '/me' && request.method === 'GET') {
        return me(env, user.userId);
    }
    if (path === '/me' && request.method === 'DELETE') {
        return deleteAccount(env, user.userId);
    }
    const m = /^\/me\/identities\/([^/]+)$/.exec(path);
    if (m && request.method === 'DELETE') {
        return removeIdentity(env, user.userId, m[1]);
    }
    if (path === '/me/hosts' && request.method === 'GET') {
        return hosts(env, user.userId);
    }
    const h = /^\/me\/hosts\/([^/]+)$/.exec(path);
    if (h && request.method === 'DELETE') {
        return removeHost(env, user.userId, h[1]);
    }
    return error(404, 'Not found');
}

// 自分のホスト（#157）。中継の鍵や公開鍵は出さない
async function hosts(env: Env, userId: string): Promise<Response> {
    const rows = await env.DB.prepare(
        'SELECT id, name, app_version, created_at, last_seen_at FROM hosts WHERE user_id = ? ORDER BY created_at',
    )
        .bind(userId)
        .all<{
            id: string;
            name: string;
            app_version: string | null;
            created_at: number;
            last_seen_at: number | null;
        }>();
    return json({
        hosts: rows.results.map((h) => ({
            id: h.id,
            name: h.name,
            appVersion: h.app_version,
            createdAt: h.created_at,
            lastSeenAt: h.last_seen_at,
        })),
    });
}

// 画面からホストを外す。トンネルと DNS レコードも消す（#159）
async function removeHost(env: Env, userId: string, hostId: string): Promise<Response> {
    const host = await env.DB.prepare('SELECT id, tunnel_id, tunnel_hostname FROM hosts WHERE id = ? AND user_id = ?')
        .bind(hostId, userId)
        .first<HostTunnel>();
    if (!host) {
        return error(404, 'そのホストはありません');
    }
    await deleteTunnel(env, host);
    await env.DB.prepare('DELETE FROM hosts WHERE id = ? AND user_id = ?').bind(hostId, userId).run();
    await env.DB.prepare('DELETE FROM pairing_requests WHERE host_id = ?').bind(hostId).run();
    return hosts(env, userId);
}

async function me(env: Env, userId: string): Promise<Response> {
    const user = await env.DB.prepare('SELECT id, display_name, tos_version FROM users WHERE id = ?')
        .bind(userId)
        .first<{ id: string; display_name: string; tos_version: string | null }>();
    if (!user) {
        return error(401, 'ログインしてください');
    }
    const identities = await env.DB.prepare(
        'SELECT id, provider, email, display_name, created_at FROM auth_identities WHERE user_id = ? ORDER BY created_at',
    )
        .bind(userId)
        .all<{ id: string; provider: string; email: string | null; display_name: string | null; created_at: number }>();
    return json({
        id: user.id,
        displayName: user.display_name,
        tosVersion: user.tos_version,
        identities: identities.results.map((i) => ({
            id: i.id,
            provider: i.provider,
            email: i.email,
            displayName: i.display_name,
            createdAt: i.created_at,
        })),
        // 足せるログインの手段
        providers: PROVIDERS,
    });
}

async function removeIdentity(env: Env, userId: string, identityId: string): Promise<Response> {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ?')
        .bind(userId)
        .first<{ n: number }>();
    if ((count?.n ?? 0) <= 1) {
        return error(409, '最後のログイン手段は外せません');
    }
    // 同時に 2 つ外されても 0 にならないよう、数えるのと消すのを 1 つの文にする
    const res = await env.DB.prepare(
        `DELETE FROM auth_identities WHERE id = ?1 AND user_id = ?2
           AND (SELECT COUNT(*) FROM auth_identities WHERE user_id = ?2) > 1`,
    )
        .bind(identityId, userId)
        .run();
    if (res.meta.changes === 0) {
        return error(404, 'そのログイン手段はありません');
    }
    return me(env, userId);
}

// 退会: ユーザー・ログイン手段・ログインセッション・ホスト・同意の履歴を消す（外部キーの CASCADE）。
// ホストのトンネルと DNS レコードは、行を消す前に消す（#159）
async function deleteAccount(env: Env, userId: string): Promise<Response> {
    await deleteUserTunnels(env, userId);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
