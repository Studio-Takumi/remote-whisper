import { type Language, getLanguage } from '@/i18n/language';
import { intlLocale } from '@/lib/format';

// ID と表示用の日時。ID の形式は spec/files.md 5.2 節の YYYYMMDD-HHMMSS
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

// 文字起こしの行の時刻。録音の開始からの秒数を HH:MM:SS にする（transcript-<ID>.md と同じ形）
export function formatClock(sec: number) {
    const s = Math.floor(sec);
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

// 文字起こしの行の時刻（HH:MM:SS）を秒にする。読めなければ null
export function clockToSeconds(time: string) {
    const parts = time.split(':').map((p) => (p.trim() === '' ? NaN : Number(p)));
    if (parts.some((n) => Number.isNaN(n))) {
        return null;
    }
    return parts.reduce((sec, n) => sec * 60 + n, 0);
}

// formatDateTime の形（YYYY-MM-DD HH:MM）を Date に戻す。読めなければ null
function parseDateTime(text: string) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : null;
}

// 左メニューに出す録音日時（ja: 10/11 14:05、en: 10/11, 2:05 PM）
export function formatShortDateTime(text: string, language: Language = getLanguage()) {
    const d = parseDateTime(text);
    if (!d) {
        return text;
    }
    if (language === 'ja') {
        return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
    return new Intl.DateTimeFormat(intlLocale(language), {
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    }).format(d);
}

// 画面に出す日時（ja: 2026-10-11 14:05、en: Oct 11, 2026, 2:05 PM）。text は formatDateTime の形で、読めなければそのまま
export function formatDisplayDateTime(text: string, language: Language = getLanguage()) {
    const d = parseDateTime(text);
    if (!d || language === 'ja') {
        return text;
    }
    return new Intl.DateTimeFormat(intlLocale(language), { dateStyle: 'medium', timeStyle: 'short' }).format(d);
}

// 録音の長さ（秒）。記録がなければ（記録する前のセッション）開始と終了の日時の差にする（分の単位まで）
export function sessionDuration(session: { startedAt: string; endedAt?: string; durationSec?: number }) {
    if (session.durationSec !== undefined) {
        return session.durationSec;
    }
    const start = parseDateTime(session.startedAt);
    const end = session.endedAt ? parseDateTime(session.endedAt) : null;
    return start && end ? Math.max(0, (end.getTime() - start.getTime()) / 1000) : undefined;
}

export function formatDateTime(date = new Date()) {
    const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${d} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 日時（ISO 8601）を画面に出す形にする
export function displayTime(iso: string | null | undefined) {
    return iso ? formatDateTime(new Date(iso)) : undefined;
}
