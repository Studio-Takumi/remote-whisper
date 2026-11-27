// ほかのクライアントで録音中のセッションを見る（#238。spec/api.md 7.2・spec/ui.md 8 章）
import type { JoinAvailability, WatchedState } from '@/api/protocol';
import type { Project, Session } from '@/api/types';
import { recordingMessages } from '@/features/recording/i18n';

// join は参加できるか（#356）。参加に対応していない古いサーバーでは undefined
export type Watching = { sessionId: string; state: WatchedState; join?: JoinAvailability };

// 見るセッション。開いているセッションが録音中で、自分で録音しているものでなければその ID。なければ null
export function watchTarget(
    projects: Project[],
    selection: { projectId: string | null; sessionId: string | null },
    recordingSessionId: string | null,
): string | null {
    const sid = selection.sessionId;
    if (sid === null || sid === recordingSessionId) {
        return null;
    }
    const session = projects.flatMap((p) => p.sessions).find((s) => s.id === sid);
    return session?.status === 'recording' ? sid : null;
}

// 開いているセッションを、ほかのクライアントで録音しているか（見ているだけか）。
// 一覧の status が録音中で、自分で録音していないもの
export function recordedElsewhere(session: Session | undefined, recordingSessionId: string | null) {
    return session !== undefined && session.status === 'recording' && session.id !== recordingSessionId;
}

// 見ている側の画面に出す、録音の状態の説明
export function describeWatched(state: WatchedState | undefined) {
    switch (state) {
        case 'paused':
            return recordingMessages.t('watch.paused');
        case 'disconnected':
            return recordingMessages.t('watch.disconnected');
        case 'stopped':
            return recordingMessages.t('watch.stopped');
        default:
            return recordingMessages.t('watch.recording');
    }
}
