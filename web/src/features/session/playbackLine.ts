// 録音の再生位置に当たる文字起こしの行（#122）

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
