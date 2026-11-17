// 手元で中身を積み上げているセッション（自分の録音中・最終の要約を待っている・デモのもの。#361）。
// サーバーの一覧にまだない・サーバーより先に進んでいるので、キャッシュではなくストアに持ち、キャッシュのものより先に使う
import type { Session } from '@/api/types';

export type LocalSession = { projectId: string; session: Session };

export function findLocal(list: LocalSession[], sessionId: string | null | undefined) {
    return list.find((x) => x.session.id === sessionId);
}

// 1 つを書き換える（なければそのまま）
export function patchLocal(list: LocalSession[], sessionId: string, fn: (s: Session) => Session): LocalSession[] {
    return list.map((x) => (x.session.id === sessionId ? { ...x, session: fn(x.session) } : x));
}

// 先頭に入れる（同じ ID のものは置き換える）
export function putLocal(list: LocalSession[], entry: LocalSession): LocalSession[] {
    return [entry, ...list.filter((x) => x.session.id !== entry.session.id)];
}
