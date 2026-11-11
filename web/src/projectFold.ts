// サイドバーのプロジェクトの開閉（#318。spec/ui.md 1）。端末ごとの好みなので、setting.json ではなくブラウザ（localStorage）に覚える。
// 覚えるのは閉じているプロジェクトの ID。新しいプロジェクトは開いて出る（基本は全部開いておく）

const KEY = 'rw.closedProjects';

// クラウド版ではホストごとに分ける（プロジェクトの ID はパスからできているので、ホストをまたぐと重なりうる）
export function closedKey(hostId: string | null): string {
    return hostId ? `${KEY}.${hostId}` : KEY;
}

export function loadClosed(hostId: string | null, storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
    try {
        const raw = storage?.getItem(closedKey(hostId));
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        return [];
    }
}

export function saveClosed(
    hostId: string | null,
    closed: string[],
    storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage(),
) {
    try {
        if (closed.length === 0) {
            storage?.removeItem(closedKey(hostId));
        } else {
            storage?.setItem(closedKey(hostId), JSON.stringify(closed));
        }
    } catch {
        // 保存できなくても、この画面の間は使える
    }
}

// 開いているプロジェクト（Accordion の value）
export function openIds(projectIds: string[], closed: string[]): string[] {
    const set = new Set(closed);
    return projectIds.filter((id) => !set.has(id));
}

// 開いているものから、閉じているものを出し直す。今ないプロジェクト（消した・移した）の ID はここで落ちる
export function closedIds(projectIds: string[], open: string[]): string[] {
    const set = new Set(open);
    return projectIds.filter((id) => !set.has(id));
}

function safeStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}
