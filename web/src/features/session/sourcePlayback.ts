// 再生する音源の切り替え（#371。spec/ui.md 8）
import type { SessionSource } from '@/features/session/sources';

// 再生する音源を選べるときの音源（フロントマターの順）。録音ファイルの残っている音源だけ。
// recordings（files.sourceRecordings）がない古いサーバーは GET .../recording の source を無視して主の音源を返すので、
// 選ばせない（spec/api.md 7.1）。選べる音源が 2 つ未満なら空（主の音源だけを再生する）
export function playableSources(
    stored: SessionSource[] | undefined,
    recordings: number[] | undefined,
): SessionSource[] {
    if (!stored || stored.length < 2 || !recordings) {
        return [];
    }
    const list = stored.filter((s) => recordings.includes(s.id));
    return list.length >= 2 && list.some((s) => s.id === 1) ? list : [];
}

// 録音ファイルの URL のクエリ。主の音源は今までと同じ URL にする
export function recordingQuery(source: number) {
    return source > 1 ? `?source=${source}` : '';
}

// 主の音源の時刻 = 音源の時刻 × (1 − driftPpm × 10⁻⁶) + offsetSec（spec/files.md 5.5）。主の音源はそのまま
function scale(source: SessionSource | undefined) {
    return source && source.id > 1 ? 1 - (source.driftPpm ?? 0) * 1e-6 : 1;
}

function offset(source: SessionSource | undefined) {
    return source && source.id > 1 ? (source.offsetSec ?? 0) : 0;
}

export function toMainTime(sourceSec: number, source: SessionSource | undefined) {
    return sourceSec * scale(source) + offset(source);
}

// 行の時刻は秒で切り捨てなので、参加した時刻のすぐ前（1 秒未満）は録音の頭とみなす
const EDGE_SEC = 1;

// 主の音源の時刻 mainSec に当たる、その音源の録音ファイルの位置。その時刻の録音がない（参加する前・抜けた後・
// ファイルの長さを超える）ときは null。durationSec はその音源のファイルの長さ（まだ分からなければ見ない）
export function toSourceTime(mainSec: number, source: SessionSource | undefined, durationSec?: number): number | null {
    if (source && source.id > 1) {
        if (source.joinedSec != null && mainSec < source.joinedSec - EDGE_SEC) {
            return null;
        }
        if (source.leftSec != null && mainSec > source.leftSec) {
            return null;
        }
    }
    const sec = (mainSec - offset(source)) / scale(source);
    if (sec < -EDGE_SEC) {
        return null;
    }
    if (durationSec !== undefined && Number.isFinite(durationSec) && sec >= durationSec) {
        return null;
    }
    return Math.max(0, sec);
}
