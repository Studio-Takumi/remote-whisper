// プロジェクトの参考資料セットの一覧。サーバーのデータなのでストアには持たず、キャッシュ（#330）に置く
import { contextSetsQuery } from '@/api/contextSets';
import type { ContextSet } from '@/api/types';
import { queryClient } from '@/app/query';

// 毎回同じ参照を返すように、空のときも定数を返す
const NO_SETS: ContextSet[] = [];

// 画面からは useCurrentContextSets（features/materials/useContextSets.ts）で読む
export function cachedContextSets(projectId: string | undefined) {
    return (projectId && queryClient.getQueryData(contextSetsQuery(projectId).queryKey)) || NO_SETS;
}

export function updateCachedContextSets(projectId: string, change: (sets: ContextSet[]) => ContextSet[]) {
    queryClient.setQueryData(contextSetsQuery(projectId).queryKey, (sets) => change(sets ?? NO_SETS));
}

// プロジェクトごとの一覧を取り直して、キャッシュに入れる。取れなかったプロジェクトは前の一覧のまま
export async function refreshContextSets(projectIds: string[]) {
    await Promise.allSettled(projectIds.map((id) => queryClient.fetchQuery({ ...contextSetsQuery(id), staleTime: 0 })));
}
