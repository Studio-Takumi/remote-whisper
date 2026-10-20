// 運営からのお知らせ（#164。docs/spec/cloud.md 10.12 節）。クラウド版の画面だけが読む。
// ダイレクト版は、announcements.json へのリクエストを出さない（外に何も送らない）

export type AnnouncementKind = 'tos' | 'release' | 'info';

export type Announcement = {
    id: string;
    kind: AnnouncementKind;
    title: string;
    url: string;
    // ISO の日付（2026-10-21）か日時。since から until までの間だけ出す
    since: string;
    until: string;
    // release のときの新しい版
    version?: string;
};

const KINDS: readonly string[] = ['tos', 'release', 'info'];
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
export const SEEN_KEY = 'remote-whisper.announcements.seen';

export const announcementsUrl = () => '/announcements.json';

// JSON から、形の合うお知らせだけを取り出す（壊れた項目は捨てる）
export function parseAnnouncements(data: unknown): Announcement[] {
    if (!Array.isArray(data)) {
        return [];
    }
    const result: Announcement[] = [];
    for (const item of data) {
        if (typeof item !== 'object' || item === null) {
            continue;
        }
        const o = item as Record<string, unknown>;
        if (
            typeof o.id !== 'string' ||
            o.id === '' ||
            typeof o.kind !== 'string' ||
            !KINDS.includes(o.kind) ||
            typeof o.title !== 'string' ||
            o.title === '' ||
            typeof o.since !== 'string' ||
            typeof o.until !== 'string'
        ) {
            continue;
        }
        result.push({
            id: o.id,
            kind: o.kind as AnnouncementKind,
            title: o.title,
            url: typeof o.url === 'string' ? o.url : '',
            since: o.since,
            until: o.until,
            ...(typeof o.version === 'string' ? { version: o.version } : {}),
        });
    }
    return result;
}

// 期間内か。日付だけの until は、その日いっぱいを含める。読めない日付のお知らせは出さない
export function isActive(a: Pick<Announcement, 'since' | 'until'>, now: number): boolean {
    const since = Date.parse(a.since);
    const untilStart = Date.parse(a.until);
    if (Number.isNaN(since) || Number.isNaN(untilStart)) {
        return false;
    }
    const until = DATE_ONLY.test(a.until) ? untilStart + DAY_MS : untilStart;
    return since <= now && now < until;
}

// 期間内で、まだ見ていないもの
export function pickVisible(list: Announcement[], seen: ReadonlySet<string>, now: number): Announcement[] {
    return list.filter((a) => !seen.has(a.id) && isActive(a, now));
}

// リンクにしてよい URL（https のものだけ）。それ以外は null
export function safeHttpsUrl(url: string): string | null {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' ? u.href : null;
    } catch {
        return null;
    }
}

function safeLocalStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}

export function loadSeen(storage: Pick<Storage, 'getItem'> | null = safeLocalStorage()): Set<string> {
    try {
        const raw = storage?.getItem(SEEN_KEY);
        const data: unknown = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : []);
    } catch {
        return new Set();
    }
}

export function saveSeen(seen: ReadonlySet<string>, storage: Pick<Storage, 'setItem'> | null = safeLocalStorage()) {
    try {
        storage?.setItem(SEEN_KEY, JSON.stringify([...seen]));
    } catch {
        // 保存できなくても、この画面の間は出さない
    }
}

// クラウド版のときだけ読みに行く。ダイレクト版は fetch を呼ばない。失敗したら空
export async function fetchAnnouncements(
    cloud: boolean,
    fetchFn: typeof fetch = (...args) => fetch(...args),
): Promise<Announcement[]> {
    if (!cloud) {
        return [];
    }
    try {
        const res = await fetchFn(announcementsUrl(), { cache: 'no-cache' });
        return res.ok ? parseAnnouncements(await res.json()) : [];
    } catch {
        return [];
    }
}
