// 自分のアカウント（#155）: /me（ログインしているか・ログイン手段の一覧）、ログイン手段を外す、退会
import { currentUser } from './auth';
import { PRIVACY_URL, TERMS_URL, TOS_VERSION, dataCollectionGranted, postConsent, putDataCollection } from './consent';
import { clearSessionCookie, error, json, sameOrigin } from './http';
import type { Env } from './index';
import { PROVIDERS } from './providers';

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
    if (path === '/me/consent' && request.method === 'POST') {
        return postConsent(request, env, user.userId);
    }
    if (path === '/me/consents/data_collection' && request.method === 'PUT') {
        return putDataCollection(request, env, user.userId);
    }
    const m = /^\/me\/identities\/([^/]+)$/.exec(path);
    if (m && request.method === 'DELETE') {
        return removeIdentity(env, user.userId, m[1]);
    }
    return error(404, 'Not found');
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
        tosCurrent: TOS_VERSION,
        termsUrl: TERMS_URL,
        privacyUrl: PRIVACY_URL,
        dataCollection: await dataCollectionGranted(env, userId),
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
// ホストのトンネルを消すのは #159 で足す
async function deleteAccount(env: Env, userId: string): Promise<Response> {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie() });
}
