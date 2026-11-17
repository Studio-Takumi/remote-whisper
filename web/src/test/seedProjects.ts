// テスト用に、プロジェクトとセッションを画面の状態に入れる・読み出す。
// 一覧と中身はキャッシュにある（#361）ので、キャッシュに入れる。vi.resetModules() のあとでも、読み込み直した
// ストアと同じキャッシュを使うように、ここでは読み込み直したモジュールを使う
import type { Project, Session } from '@/api/types';
import type { useAppStore } from '@/app/store';

type Store = typeof useAppStore;

export async function seedProjects(store: Store, projects: Project[]) {
    const { queryClient } = await import('@/app/query');
    const { projectsQuery } = await import('@/api/projects');
    const { sessionsQuery } = await import('@/api/sessions');
    const { transcriptQuery } = await import('@/api/transcripts');
    queryClient.setQueryData(
        projectsQuery.queryKey,
        projects.map(({ sessions: _sessions, ...p }) => p),
    );
    for (const p of projects) {
        queryClient.setQueryData(sessionsQuery(p.id).queryKey, p.sessions);
        for (const s of p.sessions.filter((x) => x.loaded)) {
            const { pickedTerms, manualTerms, corrections } = s;
            queryClient.setQueryData(transcriptQuery(p.id, s.id).queryKey, {
                lines: s.transcript,
                meta: { pickedTerms, manualTerms, corrections },
            });
            store.setState((st) => ({ loadedSessions: { ...st.loadedSessions, [s.id]: {} } }));
        }
    }
}

// 画面に出しているセッション（中身を取っていれば中身も）
export async function sessionReader(store: Store): Promise<(sessionId: string) => Session | undefined> {
    const { readSession } = await import('@/app/sessionData');
    return (sessionId) => readSession(store.getState(), sessionId);
}

// 画面に出しているプロジェクトの一覧（セッションは一覧の行）
export async function projectsReader(store: Store): Promise<() => Project[]> {
    const { readProjects } = await import('@/app/sessionData');
    return () => readProjects(store.getState());
}
