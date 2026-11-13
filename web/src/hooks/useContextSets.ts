import { useQuery } from '@tanstack/react-query';
import { useShallow } from 'zustand/react/shallow';

import { contextSetsQuery } from '@/data';
import { cachedContextSets, currentContextSelection, currentProject, useAppStore } from '@/store';
import type { ContextSelection, ContextSet } from '@/types';

// 開いているプロジェクトの参考資料セットの一覧（#330）。キャッシュから読む。
// 取るのはストア（プロジェクトの一覧を取り直したとき・WebSocket の通知）なので、ここでは取りに行かない
export function useCurrentContextSets(): ContextSet[] {
    const projectId = useAppStore((s) => currentProject(s)?.id);
    // プロジェクトがないときのキーは使われない（enabled: false なので取りに行かない）
    useQuery({ ...contextSetsQuery(projectId ?? ''), enabled: false });
    return cachedContextSets(projectId);
}

// 開いているプロジェクトで使う参考資料セットの選択
export function useCurrentContextSelection(sets: ContextSet[]): ContextSelection {
    return useAppStore(useShallow((s) => currentContextSelection(s, sets)));
}
