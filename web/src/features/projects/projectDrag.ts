// サイドバーのプロジェクト一覧のドラッグ（セッションを移す #172・プロジェクトを並び替える #173）
import { type CollisionDetection, closestCenter, rectIntersection } from '@dnd-kit/core';

import type { Project } from '@/api/types';
import { sortableId } from '@/features/projects/projectOrder';

export const screenReaderInstructions = {
    draggable: 'プロジェクトの並び順は、Space で持ち上げ、上下の矢印で動かし、Space で置きます。Esc でやめます',
};

// ドラッグしているセッション。data.type でプロジェクトの並び替え（#173）のドラッグと見分ける
export type Dragging = { type: 'session'; sessionId: string; projectId: string; title: string };

// プロジェクトの見出しのドラッグ（並び替え）の data
export type ProjectDrag = { type: 'project'; projectId: string };

// セッションの移動とプロジェクトの並び替えは同じ DndContext にあり、どちらの枠が相手かは枠の有効・無効で分ける
// （ProjectGroup）ので、判定の方法だけドラッグの種類で変える（spec/ui.md 8）
export const collisionDetection: CollisionDetection = (args) =>
    args.active.data.current?.type === 'project' ? closestCenter(args) : rectIntersection(args);

// listeners からキーボードの操作を除いたもの。キーボードで始められるのは見出しの握りだけにする
// （セッションのボタンで Space を押したときに、選ぶ代わりにドラッグが始まらないように）
export function pointerOnly(listeners: Record<string, unknown> | undefined) {
    const { onKeyDown, ...rest } = listeners ?? {};
    void onKeyDown;
    return rest;
}

// 読み上げの案内に使う、ドラッグの ID の名前（プロジェクト名かセッションのタイトル。見つからなければ空）。
// セッションのドラッグの ID は `<プロジェクト ID>:<セッション ID>`（ID はプロジェクトをまたぐと重なりうる）
export function dragName(projects: Project[], id: string | number | undefined | null): string {
    const key = id == null ? null : String(id);
    const project = projects.find((p) => p.id === key || sortableId(p.id) === key);
    if (project) {
        return project.name;
    }
    const session = projects
        .flatMap((p) => p.sessions.map((s) => ({ key: `${p.id}:${s.id}`, s })))
        .find((x) => x.key === key);
    return session?.s.title ?? '';
}
