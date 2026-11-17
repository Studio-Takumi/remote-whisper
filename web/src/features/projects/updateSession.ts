import type { Project, Session } from '@/api/types';

// 一覧の中の 1 つのセッションだけを書き換える
export function updateSession(projects: Project[], sessionId: string, fn: (s: Session) => Session) {
    return projects.map((p) => ({ ...p, sessions: p.sessions.map((s) => (s.id === sessionId ? fn(s) : s)) }));
}
