// ID と表示用の日時。ID の形式は spec 5.2 節の YYYYMMDD-HHMMSS
function pad(n: number) {
    return String(n).padStart(2, '0');
}

export function newId(date = new Date()) {
    const d = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    const t = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    return `${d}-${t}`;
}

// 録音の経過時間。1時間を超えたら時も出す
export function formatElapsed(sec: number) {
    const h = Math.floor(sec / 3600);
    const mm = pad(Math.floor((sec % 3600) / 60));
    const ss = pad(sec % 60);
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDateTime(date = new Date()) {
    const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${d} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
