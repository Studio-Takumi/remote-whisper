import { queryOptions } from '@tanstack/react-query';

import { api } from '@/api/api';
import { KEEP } from '@/api/queryCommon';
import type { ContextSet } from '@/api/types';
import { queryKeys } from '@/app/query';

// プロジェクトの参考資料セットの一覧（queryKeys.contextSets()）。ID の昇順（サーバーと同じ）
export const contextSetsQuery = (projectId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.contextSets(projectId),
        queryFn: () => api.get<ContextSet[]>(`/api/projects/${projectId}/context-sets`),
    });
