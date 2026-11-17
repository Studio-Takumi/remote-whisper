import { queryOptions } from '@tanstack/react-query';

import { type SummaryInfoJson, type SummaryJson, api } from '@/api/api';
import type { Summary } from '@/api/types';
import { KEEP, queryKeys } from '@/app/query';
import { displayTime } from '@/lib/time';

// 最終の要約の一覧（queryKeys.summaries()。版 ID・モデル・生成日時）。作り直すと増える
export const summariesQuery = (projectId: string, sessionId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.summaries(projectId, sessionId),
        queryFn: () => api.get<SummaryInfoJson[]>(`/api/projects/${projectId}/sessions/${sessionId}/summaries`),
    });

// 最終の要約の 1 つの版（queryKeys.summary()）。版のファイルは書き換わらないので、一度取ったらキャッシュのものを使う
export const summaryQuery = (projectId: string, sessionId: string, gid: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.summary(projectId, sessionId, gid),
        queryFn: () => api.get<SummaryJson>(`/api/projects/${projectId}/sessions/${sessionId}/summaries/${gid}`),
        staleTime: Infinity,
    });

// 途中の要約（GET .../summaries/latest。最終の要約がまだないときに返る）。キーは queryKeys.summary(…, 'latest')。
// 録音中に作り直されるので、キャッシュのものは使わずに毎回取り直す
export const liveSummaryQuery = (projectId: string, sessionId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.summary(projectId, sessionId, 'latest'),
        queryFn: () => api.get<SummaryJson>(`/api/projects/${projectId}/sessions/${sessionId}/summaries/latest`),
        staleTime: 0,
    });

// 最終の要約の版を、画面で持つ形にする
export function toSummary(info: SummaryInfoJson, text: string | undefined): Summary {
    return {
        generationId: info.generationId,
        model: info.model,
        overviewModel: info.overviewModel ?? info.model,
        generatedAt: displayTime(info.generatedAt) ?? '',
        text,
    };
}
