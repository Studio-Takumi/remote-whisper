// サイドバーのプロジェクトの並び替え（#173）。並び順の保存はサーバー（setting.json の projectOrder）
import { arrayMove } from '@dnd-kit/sortable';

// 並び替え用のドラッグの ID。セッションを離す先（プロジェクトの ID）と重ならないよう、接頭辞を付ける
const PREFIX = 'project:';

export function sortableId(projectId: string) {
    return `${PREFIX}${projectId}`;
}

// ドラッグの ID からプロジェクトの ID を取り出す。並び替え用の ID でなければ null
export function projectIdOf(sortable: string | number | null | undefined): string | null {
    return typeof sortable === 'string' && sortable.startsWith(PREFIX) ? sortable.slice(PREFIX.length) : null;
}

// active のプロジェクトを over のプロジェクトの位置へ動かした並び。動かないとき（同じ位置・外で離した・知らない ID）は null
export function reorderedIds(ids: string[], active: string, over: string | null | undefined): string[] | null {
    const from = ids.indexOf(active);
    const to = over ? ids.indexOf(over) : -1;
    return from < 0 || to < 0 || from === to ? null : arrayMove(ids, from, to);
}

// ids の順に projects を並べ直す（ids にないものは今の順のまま後ろに）
export function sortByIds<T extends { id: string }>(projects: T[], ids: string[]): T[] {
    const rank = new Map(ids.map((id, i) => [id, i]));
    return [...projects].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}
