// サーバーから取ったデータのキャッシュ（TanStack Query。#330）。
// 取るのは api.request()（api.ts）のまま。画面からは useQuery で、ストアからは queryClient で使う
import { MutationObserver, type MutationOptions, QueryClient, notifyManager } from '@tanstack/react-query';

// キャッシュの変化を、既定の setTimeout ではなくマイクロタスクで画面に知らせる。セッションの中身はキャッシュに、
// partial はストアにあるので（#361）、同じメッセージでの両方の変化が、描く前にそろうようにする
notifyManager.setScheduler(queueMicrotask);

// 一覧とセッションの中身は、WebSocket の通知でストアが書き換えるので、既定の 5 分で捨てない（#361。spec/notes.md 9.5）
export const KEEP = { gcTime: Infinity } as const;

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

// mutation を 1 回行う（onMutate → mutationFn → onSuccess か onError → onSettled。spec/notes.md 9.5）。
// ストアからも呼ぶので、フックではなくこれを使う
export function runMutation<TData, TVariables, TContext>(
    options: MutationOptions<TData, Error, TVariables, TContext>,
    variables: TVariables,
): Promise<TData> {
    return new MutationObserver(queryClient, options).mutate(variables);
}

// queryKey は API のパス（/api を除く）を「/」で分けたもの。セッションもプロジェクトの下に置く（spec/notes.md 9.5）。
// 前方一致で無効にでき、一覧だけを取り直すときは exact: true を付ける
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
