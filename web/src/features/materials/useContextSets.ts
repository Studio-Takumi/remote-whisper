import { useMemo } from 'react';

import { useQuery } from '@tanstack/react-query';

import { contextSetsQuery } from '@/api/data';
import type { ContextSelection, ContextSet } from '@/api/types';
import { contextSelectionOf } from '@/app/selectors';
import { useCurrentProject } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';

// 毎回同じ参照を返すように、空のときも定数を返す
const NO_SETS: ContextSet[] = [];

// 開いているプロジェクトの参考資料セットの一覧（#330）。キャッシュから読む。
// 取るのはストア（プロジェクトの一覧を取り直したとき・WebSocket の通知）なので、ここでは取りに行かない
export function useCurrentContextSets(): ContextSet[] {
    const projectId = useCurrentProject()?.id;
    // プロジェクトがないときのキーは使われない（enabled: false なので取りに行かない）
    const { data } = useQuery({ ...contextSetsQuery(projectId ?? ''), enabled: false });
    return (projectId && data) || NO_SETS;
}

// 開いているプロジェクトで使う参考資料セットの選択
export function useCurrentContextSelection(sets: ContextSet[]): ContextSelection {
    const project = useCurrentProject();
    const overrides = useAppStore((s) => s.contextSelections);
    const id = project?.id;
    const saved = project?.selection;
    return useMemo(
        () => contextSelectionOf(id ? { id, selection: saved } : undefined, overrides, sets),
        [id, saved, overrides, sets],
    );
}
