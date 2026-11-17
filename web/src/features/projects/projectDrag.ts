// サイドバーのプロジェクト一覧のドラッグ（セッションを移す #172・プロジェクトを並び替える #173）
import { type CollisionDetection, closestCenter, rectIntersection } from '@dnd-kit/core';

export const screenReaderInstructions = {
    draggable: 'プロジェクトの並び順は、Space で持ち上げ、上下の矢印で動かし、Space で置きます。Esc でやめます',
};

// ドラッグしているセッション。data.type でプロジェクトの並び替え（#173）のドラッグと見分ける
export type Dragging = { type: 'session'; sessionId: string; projectId: string; title: string };

// プロジェクトの見出しのドラッグ（並び替え）の data
export type ProjectDrag = { type: 'project'; projectId: string };

// 同じ DndContext の中に、セッションを別のプロジェクトへ移すドラッグ（離す先はプロジェクトの枠）と、
// プロジェクトの並び替え（離す先はほかのプロジェクトの見出し）がある。どちらの枠が相手になるかは
// 枠を有効にするかで分けている（ProjectGroup）ので、判定の方法だけドラッグの種類で変える
export const collisionDetection: CollisionDetection = (args) =>
    args.active.data.current?.type === 'project' ? closestCenter(args) : rectIntersection(args);

// useDraggable / useSortable の listeners からキーボードの操作を除いたもの。
// キーボードで始められるのは見出しの握りだけにする（セッションのボタンで Space を押したときに、選ぶ代わりに
// ドラッグが始まらないように）
export function pointerOnly(listeners: Record<string, unknown> | undefined) {
    const { onKeyDown, ...rest } = listeners ?? {};
    void onKeyDown;
    return rest;
}
