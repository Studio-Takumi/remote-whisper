// 最新のリリース（#472・#477。spec/cloud.md 10.12）。ホストがアップデートを確かめるのに、起動時と 24 時間ごとに読む。
// relay 自身の版（デプロイのとき APP_VERSION に渡す。git describe 由来）の vX.Y.Z を返す。GitHub には問い合わせない
//
// 確かめに来るたびに、Analytics Engine に 1 行書く（ホストの版とホストの ID だけ。spec/cloud.md 10.9）。
// 国など cf 由来の値・IP アドレスは書かない。形の違うものは書かない（応答は返す）。書けなくても応答は止めない
import { json } from './http';
import type { Env } from './index';

export const RELEASES_PATH = '/releases/latest';
export const RELEASE_PAGE = 'https://github.com/Studio-Takumi/remote-whisper/releases/tag/';
// ホストが付けて送るヘッダー（server/src/remote_whisper/update_check.py と同じ名前）
export const VERSION_HEADER = 'X-RW-Version';
export const ID_HEADER = 'X-RW-Id';

// v1.1.0・v1.1.0+abc1234・v1.1.0+abc1234.dirty。頭の vX.Y.Z を取る（-rc やハッシュだけは取れない）
const RELEASE_VERSION = /^(v\d+\.\d+\.\d+)(?:\+[0-9A-Za-z.]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ホストの版（pairing.ts の appVersion と同じ形）
const APP_VERSION = /^[\w.+-]{1,32}$/;

export type LatestRelease = { version: string; url: string; publishedAt: string | null };

// relay 自身の版から最新のリリースを作る。取れなければ（ハッシュだけ・unknown・未設定など）null
export function latestFromAppVersion(appVersion: string | undefined): LatestRelease | null {
    const version = RELEASE_VERSION.exec(appVersion ?? '')?.[1];
    if (!version) {
        return null;
    }
    return { version, url: RELEASE_PAGE + version, publishedAt: null };
}

function latestRelease(env: Env): Response {
    const latest = latestFromAppVersion(env.APP_VERSION);
    return latest ? json(latest) : json({ detail: 'リリースがありません' }, 404);
}

export type UpdateCheckDataPoint = { blobs: string[]; doubles: number[]; indexes: string[] };

// 書く 1 行。ID が UUID の形でない・版の形が違うときは null（書かない）
export function updateCheckDataPoint(request: Request): UpdateCheckDataPoint | null {
    const version = request.headers.get(VERSION_HEADER) ?? '';
    const id = request.headers.get(ID_HEADER) ?? '';
    if (!APP_VERSION.test(version) || !UUID.test(id)) {
        return null;
    }
    // 1 種類 2 ホストの版。サンプリングの単位はホストの ID
    return { blobs: ['update_check', version], doubles: [], indexes: [id.toLowerCase()] };
}

function recordUpdateCheck(env: Env, request: Request) {
    try {
        const point = updateCheckDataPoint(request);
        if (point) {
            env.METRICS?.writeDataPoint(point);
        }
    } catch (e) {
        console.warn(`failed to write a metric: ${(e as Error).message}`);
    }
}

// GET /releases/latest
export function handleReleases(request: Request, env: Env): Response {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    recordUpdateCheck(env, request);
    return latestRelease(env);
}
