// セッションの画面に出す中身の判定（期限切れ・共有する中身・参加できるか）
import type { Session, TranscriptLine } from '@/api/types';
import { joinUnavailable } from '@/features/recording/join';
import type { Watching } from '@/features/recording/watch';
import type { ShareSource } from '@/features/session/share';

// 共有する中身。文字起こしは画面に出している世代
export function shareSource(session: Session, summary: string | undefined, lines?: TranscriptLine[]): ShareSource {
    return {
        title: session.title,
        summary,
        transcript: lines ?? session.finalTranscript?.lines ?? session.transcript,
    };
}

// 見ている録音に、この端末のマイクで参加できるか（#357。押せるならマイクボタンが「この端末のマイクで参加」になる）
export function canJoin(watching: Watching | null, sessionId: string) {
    return watching?.sessionId === sessionId && joinUnavailable(watching.join) === null;
}

// 保存期間を過ぎて、ファイルが消えているか（spec/flows.md 6.8）。サーバーから取ったセッションだけ判定できる
// 要約は「まだ作っていない」と区別できないので、文字起こしも消えているときだけ期限切れとみなす
export function expired(session: Session, what: 'transcript' | 'summary') {
    const files = session.files;
    if (!files || !session.loaded || session.status === 'recording') {
        return false;
    }
    if (what === 'transcript') {
        return !files.transcript;
    }
    return !files.transcript && files.summaries === 0 && !files.liveSummary;
}
