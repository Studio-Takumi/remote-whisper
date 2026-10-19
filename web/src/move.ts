// セッションを別のプロジェクトへ移す（#172）。移せるかどうかはサーバー（routes/sessions.py の
// move_blocker）と同じ条件で、画面でも先に見る（ドラッグを始められないようにして理由を出す）
import type { GpuJobs } from '@/protocol';
import type { Session } from '@/types';

export type MoveState = {
    jobs: GpuJobs;
    transcribing: string[];
    summarizing: string[];
    // この端末で録音しているセッション
    recordingSessionId: string | null;
};

// 移せない理由。移せるなら null
export function moveBlocker(session: Session, state: MoveState): string | null {
    const id = session.id;
    if (session.status === 'recording' || state.recordingSessionId === id) {
        return '録音中のセッションは移せません';
    }
    if (state.transcribing.includes(id)) {
        return '浄書済み文字起こしを作っている途中のセッションは移せません';
    }
    if (state.summarizing.includes(id)) {
        return '要約を作っている途中のセッションは移せません';
    }
    const jobs = [state.jobs.running, ...state.jobs.waiting];
    if (jobs.some((j) => j?.session === id)) {
        return 'GPU の処理を待っている・実行しているセッションは移せません';
    }
    return null;
}

// セッションの並び（新しい録音が上）
export function sortSessions<T extends { startedAt: string }>(sessions: T[]): T[] {
    return [...sessions].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

// ドラッグを離したところから、移す先のプロジェクト。同じプロジェクトや、外で離したときは null
export function moveTarget(from: string, over: string | null | undefined): string | null {
    return over && over !== from ? over : null;
}
