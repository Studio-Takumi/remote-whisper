// マイクボタンのキーボードのショートカット（#236。spec/files.md 5.3・spec/ui.md 8 章）。
// 全体設定の display.micShortcut に「修飾キー + キー」の形で持つ。修飾キーは Ctrl・Alt・Shift・Meta の順、
// キーは KeyboardEvent.code（KeyM・Digit1・F2 など）。キーの配列や IME・Mac の Option で
// key（入る文字）が変わっても同じキーとみなせるよう、key ではなく code で比べる。空なら使わない

export const DEFAULT_MIC_SHORTCUT = 'Alt+Shift+KeyM';

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;

// 押されたキーが修飾キーそのものか（Shift だけを押した、など）
function isModifierCode(code: string) {
    return /^(Control|Alt|Shift|Meta|OS)/.test(code);
}

type KeyLike = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>;

function modifiersOf(e: KeyLike) {
    const flags = { Ctrl: e.ctrlKey, Alt: e.altKey, Shift: e.shiftKey, Meta: e.metaKey };
    return MODIFIERS.filter((m) => flags[m]);
}

// 設定でキーを決めるとき、押されたキーから組み合わせを作る。
// 修飾キーだけ（まだ押している途中）なら waiting、修飾キーがなければ needsModifier
export type CaptureResult = { kind: 'combo'; combo: string } | { kind: 'waiting' } | { kind: 'needsModifier' };

export function captureShortcut(e: KeyLike): CaptureResult {
    if (e.code === '' || isModifierCode(e.code)) {
        return { kind: 'waiting' };
    }
    const mods = modifiersOf(e);
    if (mods.length === 0) {
        return { kind: 'needsModifier' };
    }
    return { kind: 'combo', combo: [...mods, e.code].join('+') };
}

// 押されたキーが設定の組み合わせと同じか。修飾キーは過不足なく一致したときだけ
export function matchesShortcut(e: KeyLike, combo: string) {
    if (combo === '') {
        return false;
    }
    const result = captureShortcut(e);
    return result.kind === 'combo' && result.combo === combo;
}

export function isMacPlatform() {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const MAC_LABELS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
const PC_LABELS: Record<string, string> = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };

// code を画面に出す名前にする（KeyM → M、Digit1 → 1、ArrowUp → ↑）
function keyLabel(code: string) {
    const arrows: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    if (arrows[code]) {
        return arrows[code];
    }
    return code
        .replace(/^Key(?=[A-Z]$)/, '')
        .replace(/^Digit(?=\d$)/, '')
        .replace(/^Numpad(?=\d$)/, 'Num ');
}

// 画面に出す形。Mac は記号（⌥⇧M）、それ以外は Alt+Shift+M
export function formatShortcut(combo: string, mac = isMacPlatform()) {
    if (combo === '') {
        return '';
    }
    const parts = combo.split('+');
    const key = keyLabel(parts[parts.length - 1]);
    const mods = parts.slice(0, -1).map((m) => (mac ? MAC_LABELS : PC_LABELS)[m] ?? m);
    return mac ? [...mods, key].join('') : [...mods, key].join('+');
}

// aria-keyshortcuts の値（WAI-ARIA の書き方。Ctrl は Control、キーは文字）
export function ariaShortcut(combo: string) {
    if (combo === '') {
        return undefined;
    }
    const parts = combo.split('+');
    const key = parts[parts.length - 1].replace(/^Key(?=[A-Z]$)/, '').replace(/^Digit(?=\d$)/, '');
    return [...parts.slice(0, -1).map((m) => (m === 'Ctrl' ? 'Control' : m)), key].join('+');
}

// 文字を入力している途中か（input・textarea・select・contenteditable にフォーカスがある）
export function isTypingTarget(target: EventTarget | null) {
    if (!(target instanceof HTMLElement)) {
        return false;
    }
    if (target.isContentEditable) {
        return true;
    }
    const tag = target.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    if (tag === 'INPUT') {
        // チェックボックスやボタンは文字を入力しない
        const type = (target as HTMLInputElement).type;
        return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type);
    }
    return false;
}

// モーダル・ダイアログ（設定・確認・サイドバーのシートなど）が開いているか
export function isModalOpen(doc: Document = document) {
    return doc.querySelector('[role="dialog"], [role="alertdialog"], [aria-modal="true"]') !== null;
}

// ショートカットとしてマイクボタンを押してよいか
export function shouldHandleMicShortcut(e: KeyboardEvent, combo: string, doc: Document = document) {
    if (e.repeat || e.isComposing || e.defaultPrevented) {
        return false;
    }
    if (!matchesShortcut(e, combo)) {
        return false;
    }
    return !isTypingTarget(e.target) && !isModalOpen(doc);
}
