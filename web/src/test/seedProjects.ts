// テスト用に、プロジェクトとセッションを画面の状態に入れる・読み出す
import type { Project, Session } from '@/api/types';
import type { useAppStore } from '@/app/store';

type Store = typeof useAppStore;

export async function seedProjects(store: Store, projects: Project[]) {
    store.setState({ projects });
}

// 画面に出しているセッション（一覧と中身）
export function findSession(store: Store, sessionId: string): Session | undefined {
    return store
        .getState()
        .projects.flatMap((p) => p.sessions)
        .find((x) => x.id === sessionId);
}
