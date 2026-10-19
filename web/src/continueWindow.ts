// 録音を終えたあと、同じセッションの続きを録音できる残りの時間（#174）。
// サーバー（recording.py の check_continuable）と同じ条件で、マイクボタンを「続きから録音」にするかを決める
import type { Session } from '@/types';

// 残りの秒数。続けられない（録音中・音声ファイルから作った・時間を過ぎた）なら null。
// 途中で終わった（interrupted）セッションは、時間を過ぎてもセッション画面のボタンから続けられるが、
// マイクボタンを「続きから録音」にするのは、普通に終えたときと同じ時間の間だけ
export function continueLeftSec(
    session: Pick<Session, 'status' | 'endedAt' | 'uploaded'>,
    windowMin: number,
    nowMs: number,
): number | null {
    if ((session.status !== 'done' && session.status !== 'interrupted') || session.uploaded || !session.endedAt) {
        return null;
    }
    const ended = Date.parse(session.endedAt);
    if (Number.isNaN(ended)) {
        return null;
    }
    const left = windowMin * 60 - (nowMs - ended) / 1000;
    return left > 0 ? left : null;
}

// 残りの時間の表示（「あと 7 分」。1 分を切ったら「あと 1 分未満」）
export function describeLeft(leftSec: number): string {
    return leftSec < 60 ? 'あと 1 分未満' : `あと ${Math.floor(leftSec / 60)} 分`;
}
