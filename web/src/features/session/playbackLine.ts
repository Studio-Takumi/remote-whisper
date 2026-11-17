// 録音の再生位置に当たる文字起こしの行（#122）
import type { Playback } from '@/features/session/Transcript';

// 再生位置（秒）に当たる行。行の始まり（starts は時刻の順）が再生位置以前の、最後の行。まだなければ null
export function lineAt(starts: number[], sec: number) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= sec) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo > 0 ? lo - 1 : null;
}

export type SessionPlayback = Playback & { sessionId: string };

// 再生位置が動いたときの次の状態。行・再生中かが変わらず、シークもしていなければ前のまま（描き直さない）。
// シークした回数は同じセッションのあいだだけ数える
export function nextPlayback(
    prev: SessionPlayback | null,
    sessionId: string,
    index: number | null,
    playing: boolean,
    seeked: boolean,
): SessionPlayback {
    const same = prev?.sessionId === sessionId;
    if (same && prev.index === index && prev.playing === playing && !seeked) {
        return prev;
    }
    const seeks = (same ? prev.seeks : 0) + (seeked ? 1 : 0);
    return { sessionId, index, playing, seeks };
}
