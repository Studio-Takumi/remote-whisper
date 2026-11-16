// サーバーから取ったデータのキャッシュ（TanStack Query。#330）。
// 取るのは api.request()（api.ts）のまま。画面からは useQuery で、ストアからは queryClient で使う
import { MutationObserver, type MutationOptions, QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
    defaultOptions: {
        queries: {
            // ホストが落ちているときは、今までどおりすぐにエラーを出す（取り直しを重ねて待たせない）
            retry: false,
            // 変わったことは WebSocket の通知で知るので、画面に戻ったときには取り直さない
            refetchOnWindowFocus: false,
        },
    },
});

// サーバーのデータを変える操作（mutation）を 1 回行う。useMutation と同じく、onMutate（楽観的更新）→
// mutationFn → onSuccess か onError（巻き戻し）→ onSettled の順に呼ぶ。失敗したら投げる。
// 操作はストアからも（WebSocket の通知や、ほかの操作の続きとして）呼ぶので、フックではなくこれを使う
export function runMutation<TData, TVariables, TContext>(
    options: MutationOptions<TData, Error, TVariables, TContext>,
    variables: TVariables,
): Promise<TData> {
    return new MutationObserver(queryClient, options).mutate(variables);
}

// queryKey の決まり。API のパス（/api を除く）を「/」で分けたものにする。
// 例: GET /api/projects/{pid}/sessions/{sid}/transcript → ['projects', pid, 'sessions', sid, 'transcript']
// セッション ID は日時なので、プロジェクトをまたぐと重なることがある。そのためセッションのものもプロジェクトの下に置く。
// 前方一致で無効にできる（['projects', pid] でそのプロジェクトの下を全部）。一覧だけを取り直すときは exact: true を付ける
export const queryKeys = {
    // GET /api/projects（プロジェクトの一覧。セッションは入らない）
    projects: () => ['projects'] as const,
    project: (projectId: string) => ['projects', projectId] as const,
    // GET /api/projects/{pid}/sessions
    sessions: (projectId: string) => ['projects', projectId, 'sessions'] as const,
    // GET /api/projects/{pid}/context-sets
    contextSets: (projectId: string) => ['projects', projectId, 'context-sets'] as const,
    // GET /api/projects/{pid}/sessions/{sid}/transcript
    transcript: (projectId: string, sessionId: string) =>
        ['projects', projectId, 'sessions', sessionId, 'transcript'] as const,
    // GET /api/projects/{pid}/sessions/{sid}/final-transcripts（版の一覧）と、/{gid}（1 つの版）
    finalTranscripts: (projectId: string, sessionId: string) =>
        ['projects', projectId, 'sessions', sessionId, 'final-transcripts'] as const,
    finalTranscript: (projectId: string, sessionId: string, gid: string) =>
        ['projects', projectId, 'sessions', sessionId, 'final-transcripts', gid] as const,
    // GET /api/projects/{pid}/sessions/{sid}/summaries（版の一覧）と、/{gid}（1 つの版）
    summaries: (projectId: string, sessionId: string) =>
        ['projects', projectId, 'sessions', sessionId, 'summaries'] as const,
    summary: (projectId: string, sessionId: string, gid: string) =>
        ['projects', projectId, 'sessions', sessionId, 'summaries', gid] as const,
};
