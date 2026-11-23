// 最新のリリース（#472。spec/cloud.md 10.12）。ホストがアップデートを確かめるのに、起動時と 24 時間ごとに読む。
// GitHub Releases の最新（下書き・プレリリース・-rc などは除く）を返し、Worker で 1 時間キャッシュする
// （リリースのたびにデプロイしなくてよい。未認証の GitHub API の回数の制限にもかからない）。
//
// 確かめに来るたびに、Analytics Engine に 1 行書く（ホストの版とホストの ID だけ。spec/cloud.md 10.9）。
// 国など cf 由来の値・IP アドレスは書かない。形の違うものは書かない（応答は返す）。書けなくても応答は止めない
import { json } from './http';
import type { Env } from './index';

export const RELEASES_PATH = '/releases/latest';
export const GITHUB_RELEASES_URL = 'https://api.github.com/repos/Studio-Takumi/remote-whisper/releases?per_page=30';
// ホストが付けて送るヘッダー（server/src/remote_whisper/update_check.py と同じ名前）
export const VERSION_HEADER = 'X-RW-Version';
export const ID_HEADER = 'X-RW-Id';

// 取れたとき（なかったときも）は 1 時間、GitHub に届かなかったときは 5 分キャッシュする
export const CACHE_SEC = 60 * 60;
export const FAILURE_CACHE_SEC = 5 * 60;

const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ホストの版（pairing.ts の appVersion と同じ形）
const APP_VERSION = /^[\w.+-]{1,32}$/;

export type LatestRelease = { version: string; url: string; publishedAt: string | null };

type GitHubRelease = {
    tag_name?: unknown;
    html_url?: unknown;
    draft?: unknown;
    prerelease?: unknown;
    published_at?: unknown;
};

function parts(tag: string): number[] {
    return RELEASE_TAG.exec(tag)!.slice(1, 4).map(Number);
}

function newer(a: string, b: string): boolean {
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < 3; i++) {
        if (x[i] !== y[i]) {
            return x[i] > y[i];
        }
    }
    return false;
}

// GitHub の一覧から、正式なリリース（vX.Y.Z ちょうどのタグ）のうち一番新しい版を選ぶ。なければ null
export function pickLatest(releases: unknown): LatestRelease | null {
    if (!Array.isArray(releases)) {
        return null;
    }
    let latest: LatestRelease | null = null;
    for (const r of releases as GitHubRelease[]) {
        if (typeof r !== 'object' || r === null || r.draft === true || r.prerelease === true) {
            continue;
        }
        const tag = r.tag_name;
        const url = r.html_url;
        if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) {
            continue;
        }
        if (typeof url !== 'string' || !url.startsWith('https://github.com/')) {
            continue;
        }
        if (latest === null || newer(tag, latest.version)) {
            latest = { version: tag, url, publishedAt: typeof r.published_at === 'string' ? r.published_at : null };
        }
    }
    return latest;
}

async function fromGitHub(): Promise<Response> {
    try {
        const res = await fetch(GITHUB_RELEASES_URL, {
            headers: {
                // GitHub API は User-Agent がないと断る
                'User-Agent': 'remote-whisper-relay',
                Accept: 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
            },
        });
        if (!res.ok) {
            console.warn(`GitHub releases: ${res.status}`);
            return cacheable(json({ detail: 'リリースを取れません' }, 502), FAILURE_CACHE_SEC);
        }
        const latest = pickLatest(await res.json());
        if (latest === null) {
            return cacheable(json({ detail: 'リリースがありません' }, 404), CACHE_SEC);
        }
        return cacheable(json(latest), CACHE_SEC);
    } catch (e) {
        console.warn(`GitHub releases: ${(e as Error).message}`);
        return cacheable(json({ detail: 'リリースを取れません' }, 502), FAILURE_CACHE_SEC);
    }
}

function cacheable(response: Response, sec: number): Response {
    response.headers.set('Cache-Control', `public, max-age=${sec}`);
    return response;
}

// Worker のキャッシュ（Cache API）の鍵。クエリやヘッダーで分けない
export function cacheKey(request: Request): Request {
    return new Request(new URL(RELEASES_PATH, request.url).toString());
}

async function latestRelease(request: Request): Promise<Response> {
    const key = cacheKey(request);
    try {
        const hit = await caches.default.match(key);
        if (hit) {
            return hit;
        }
    } catch (e) {
        console.warn(`cache: ${(e as Error).message}`);
    }
    const response = await fromGitHub();
    try {
        await caches.default.put(key, response.clone());
    } catch (e) {
        console.warn(`cache: ${(e as Error).message}`);
    }
    return response;
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
export async function handleReleases(request: Request, env: Env): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    recordUpdateCheck(env, request);
    return latestRelease(request);
}
