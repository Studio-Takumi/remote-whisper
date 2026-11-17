import { hashKey, queryOptions } from '@tanstack/react-query';

import { type FinalTranscriptJson, type TranscriptJson, api } from '@/api/api';
import type { FinalTranscript, FinalTranscriptInfo } from '@/api/types';
import { KEEP, queryClient, queryKeys } from '@/app/query';
import { withLineSources } from '@/features/session/sources';
import { displayTime } from '@/lib/time';

// 文字起こし（queryKeys.transcript()）。録音中・語の変更・置き換えで変わる
export const transcriptQuery = (projectId: string, sessionId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.transcript(projectId, sessionId),
        queryFn: () => api.get<TranscriptJson>(`/api/projects/${projectId}/sessions/${sessionId}/transcript`),
    });

// 最終の文字起こしの世代の一覧（queryKeys.finalTranscripts()。#124。古いものから）。作り直すと増える
export const finalTranscriptsQuery = (projectId: string, sessionId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.finalTranscripts(projectId, sessionId),
        queryFn: async (): Promise<FinalTranscriptInfo[]> => {
            const list = await api.get<FinalTranscriptJson['meta'][]>(
                `/api/projects/${projectId}/sessions/${sessionId}/final-transcripts`,
            );
            return list.map((m) => ({ ...m, generatedAt: displayTime(m.generatedAt) ?? '' }));
        },
    });

// 最終の文字起こし（#121）の 1 つの世代。書き換わらないのでキャッシュを使い、置き換え（#176）が変わったら
// forgetTranscripts で消す（spec/flows.md 6.13）
export const finalTranscriptQuery = (projectId: string, sessionId: string, gid: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.finalTranscript(projectId, sessionId, gid),
        queryFn: async (): Promise<FinalTranscript> => {
            const json = await api.get<FinalTranscriptJson>(
                `/api/projects/${projectId}/sessions/${sessionId}/final-transcripts/${gid}`,
            );
            return {
                ...json.meta,
                generatedAt: displayTime(json.meta.generatedAt) ?? '',
                // 音源が 2 つ以上なら、行ごとの音源を付ける（#357）
                lines: withLineSources(json.lines, json.meta.lineSources),
            };
        },
        staleTime: Infinity,
    });

// 文字起こし（リアルタイム）を取る。キャッシュがあっても取り直す（同時に頼まれたら 1 回にまとめる）
export function fetchTranscript(projectId: string, sessionId: string) {
    return queryClient.fetchQuery({ ...transcriptQuery(projectId, sessionId), staleTime: 0 });
}

// 最終の文字起こしの 1 つの世代
export function fetchFinalTranscript(projectId: string, sessionId: string, gid: string) {
    return queryClient.fetchQuery(finalTranscriptQuery(projectId, sessionId, gid));
}

// 最終の文字起こしの世代の一覧。キャッシュがあっても取り直す
export function fetchFinalTranscripts(projectId: string, sessionId: string) {
    return queryClient.fetchQuery({ ...finalTranscriptsQuery(projectId, sessionId), staleTime: 0 });
}

// 置き換え（#176）が変わったので、そのセッションの文字起こしと世代をキャッシュから消す。keep は消さず上書きする。
// 取得中のものは、届くのを待ってから消す（invalidate だと古い中身が残り、cancel だと待つ側がエラーになる。spec/flows.md 6.13）
export async function forgetTranscripts(
    projectId: string,
    sessionId: string,
    keep: readonly (readonly unknown[])[] = [],
) {
    const prefixes = [queryKeys.transcript(projectId, sessionId), queryKeys.finalTranscripts(projectId, sessionId)];
    const cache = queryClient.getQueryCache();
    const queries = prefixes.flatMap((queryKey) => cache.findAll({ queryKey }));
    await Promise.allSettled(queries.map((q) => q.promise));
    const kept = new Set(keep.map((key) => hashKey(key)));
    for (const q of queries) {
        if (q.state.fetchStatus === 'idle' && !kept.has(q.queryHash)) {
            cache.remove(q);
        }
    }
}

// 表示する最終の文字起こしの世代。今の全体設定の Whisper のモデルで作ったうちいちばん新しいもの。
// そのモデルのものがなければ、モデルを問わずいちばん新しいもの（要約と同じ。spec/flows.md 6.5）
export function pickFinalTranscript(infos: FinalTranscriptInfo[], model: string) {
    return infos.findLast((x) => x.model === model) ?? infos.at(-1);
}
