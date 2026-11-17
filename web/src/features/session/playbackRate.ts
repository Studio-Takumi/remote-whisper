// 録音の再生速度（#268。spec/ui.md 8）。端末ごとの好みなので、setting.json ではなくブラウザ（localStorage）に覚える

export const MIN_RATE = 0.5;
export const MAX_RATE = 3;
export const RATE_STEP = 0.05;
export const DEFAULT_RATE = 1;
// 基本の速度（メニューのボタン）
export const PRESET_RATES = [1, 1.25, 1.5, 1.75, 2] as const;

const RATE_KEY = 'rw.playbackRate';

// 範囲に収め、0.05 刻みに丸める。数でなければ等速
export function normalizeRate(value: number): number {
    if (!Number.isFinite(value)) {
        return DEFAULT_RATE;
    }
    const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
    const clamped = Math.min(MAX_RATE, Math.max(MIN_RATE, stepped));
    // 0.05 の倍数の足し算の誤差を消す
    return Math.round(clamped * 100) / 100;
}

// 入力欄の文字から。空・数でない文字は null（直さずに元へ戻す）
export function parseRate(text: string): number | null {
    // 小数点にカンマを使う入力（「1,5」）も受け付ける
    const trimmed = text.trim().replace(',', '.');
    if (trimmed === '') {
        return null;
    }
    const n = Number(trimmed);
    return Number.isFinite(n) ? normalizeRate(n) : null;
}

// 入力欄を確定したときに使う速度。読めない入力は今の速度のまま
export function commitRate(text: string, current: number): number {
    return parseRate(text) ?? current;
}

// 「1.25×」のように表示する（1 なら「1×」）
export function formatRate(rate: number): string {
    return `${rate}×`;
}

export function loadRate(storage: Pick<Storage, 'getItem'> | null = safeStorage()): number {
    try {
        const raw = storage?.getItem(RATE_KEY);
        return raw ? (parseRate(raw) ?? DEFAULT_RATE) : DEFAULT_RATE;
    } catch {
        return DEFAULT_RATE;
    }
}

export function saveRate(rate: number, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
    try {
        storage?.setItem(RATE_KEY, String(rate));
    } catch {
        // 保存できなくても、この画面の間は使える
    }
}

function safeStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}
