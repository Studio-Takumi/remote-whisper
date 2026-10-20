// 初回の同意（#162）: 利用規約の版と、データ収集の許可。仕様書 spec/cloud.md 10.7・10.11 節
import { error, json } from './http';
import type { Env } from './index';

// 今の利用規約の版。改定しても同意は取り直さない（users.tos_version が null のときだけ同意を求める）
export const TOS_VERSION = '2026-10-20';
// データ収集の説明文の版（consents.version に入れる）。説明を変えたら上げる
export const DATA_COLLECTION_VERSION = '2026-10-20';
// 文面は LP に置く。ここでは版とリンク先だけ（仮の URL）
export const TERMS_URL = 'https://studio-takumi.dev/remote-whisper/terms';
export const PRIVACY_URL = 'https://studio-takumi.dev/remote-whisper/privacy';

// データ収集の今の許可。consents の最後の行（なければ false）
export async function dataCollectionGranted(env: Env, userId: string): Promise<boolean> {
    const row = await env.DB.prepare(
        // 同じ時刻でも順序が決まるよう rowid でも並べる
        "SELECT granted FROM consents WHERE user_id = ? AND kind = 'data_collection' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    )
        .bind(userId)
        .first<{ granted: number }>();
    return row?.granted === 1;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const body = await request.json();
        return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

function insertConsent(env: Env, userId: string, kind: string, granted: boolean, version: string, now: number) {
    return env.DB.prepare(
        'INSERT INTO consents (id, user_id, kind, granted, version, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), userId, kind, granted ? 1 : 0, version, now);
}

// POST /me/consent: 初回の同意。版が今の版のときだけ受け付ける
export async function postConsent(request: Request, env: Env, userId: string): Promise<Response> {
    const body = await readBody(request);
    if (!body || typeof body.tosVersion !== 'string' || typeof body.dataCollection !== 'boolean') {
        return error(400, 'tosVersion（文字列）と dataCollection（真偽値）が必要です');
    }
    if (body.tosVersion !== TOS_VERSION) {
        return error(409, '利用規約の版が変わりました。画面を開き直してください');
    }
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('UPDATE users SET tos_version = ? WHERE id = ?').bind(TOS_VERSION, userId),
        insertConsent(env, userId, 'tos', true, TOS_VERSION, now),
        insertConsent(env, userId, 'data_collection', body.dataCollection, DATA_COLLECTION_VERSION, now),
    ]);
    return json({ ok: true });
}

// PUT /me/consents/data_collection: 設定から変える。変えるたびに追記する（同じ値でも）
export async function putDataCollection(request: Request, env: Env, userId: string): Promise<Response> {
    const body = await readBody(request);
    if (!body || typeof body.granted !== 'boolean') {
        return error(400, 'granted（真偽値）が必要です');
    }
    const user = await env.DB.prepare('SELECT tos_version FROM users WHERE id = ?')
        .bind(userId)
        .first<{ tos_version: string | null }>();
    if (!user?.tos_version) {
        return error(409, '先に利用規約に同意してください');
    }
    await insertConsent(env, userId, 'data_collection', body.granted, DATA_COLLECTION_VERSION, Date.now()).run();
    return json({ ok: true, dataCollection: body.granted });
}
