import { useSyncExternalStore } from 'react';

// 表示言語（#487。spec/ui.md 8）。端末ごとの好みなので、setting.json ではなくブラウザ（localStorage）に覚える
// 初めはブラウザの言語（日本語なら ja、ほかは en）。index.html でも同じ決め方で、描く前に <html lang> を付けている

export const languages = ['ja', 'en'] as const;
export type Language = (typeof languages)[number];

// index.html の読み込み時のスクリプトも同じキーを読む
export const LANGUAGE_KEY = 'rw.language';

export function isLanguage(value: unknown): value is Language {
    return languages.includes(value as Language);
}

// ブラウザの言語（navigator.languages の先頭）から。ja・ja-JP なら ja、ほかは en
export function detectLanguage(preferred: readonly string[]): Language {
    const first = preferred[0]?.toLowerCase() ?? '';
    return first === 'ja' || first.startsWith('ja-') ? 'ja' : 'en';
}

export function loadLanguage(
    storage: Pick<Storage, 'getItem'> | null = safeStorage(),
    preferred: readonly string[] = browserLanguages(),
): Language {
    try {
        const saved = storage?.getItem(LANGUAGE_KEY);
        if (isLanguage(saved)) {
            return saved;
        }
    } catch {
        // 読めなければブラウザの言語
    }
    return detectLanguage(preferred);
}

export function saveLanguage(language: Language, storage: Pick<Storage, 'setItem'> | null = safeStorage()) {
    try {
        storage?.setItem(LANGUAGE_KEY, language);
    } catch {
        // 保存できなくても、この画面の間は使える
    }
}

let current: Language = loadLanguage();
const listeners = new Set<() => void>();

export function getLanguage(): Language {
    return current;
}

// 切り替えた時点で効く（保存を押さなくてよい）。<html lang> も合わせる
export function setLanguage(language: Language) {
    if (language === current) {
        return;
    }
    current = language;
    saveLanguage(language);
    if (typeof document !== 'undefined') {
        document.documentElement.lang = language;
    }
    for (const listener of listeners) {
        listener();
    }
}

export function subscribeLanguage(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// 今の表示言語。切り替えると描き直す
export function useLanguage(): Language {
    return useSyncExternalStore(subscribeLanguage, getLanguage);
}

function browserLanguages(): readonly string[] {
    if (typeof navigator === 'undefined') {
        return [];
    }
    return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function safeStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}
