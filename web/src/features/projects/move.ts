// セッションを別のプロジェクトへ移す（#172）。移せるかどうかはサーバー（routes/sessions/ の
// move_blocker）と同じ条件で、画面でも先に見る（ドラッグを始められないようにして理由を出す）
import type { GpuJobs } from '@/api/protocol';
import type { Session } from '@/api/types';
import { projectsMessages } from '@/features/projects/i18n';

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
        return projectsMessages.t('move.blockedByRecording');
    }
    if (state.transcribing.includes(id)) {
        return projectsMessages.t('move.blockedByPolish');
    }
    if (state.summarizing.includes(id)) {
        return projectsMessages.t('move.blockedBySummary');
    }
    const jobs = [state.jobs.running, ...state.jobs.waiting];
    if (jobs.some((j) => j?.session === id)) {
        return projectsMessages.t('move.blockedByGpu');
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
