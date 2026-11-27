import { afterEach, describe, expect, it, vi } from 'vitest';

import html from '../../index.html?raw';
import {
    LANGUAGE_KEY,
    detectLanguage,
    getLanguage,
    htmlLang,
    languages,
    loadLanguage,
    setLanguage,
    subscribeLanguage,
} from './language';

function storageWith(value: string | null) {
    return { getItem: (key: string) => (key === LANGUAGE_KEY ? value : null) };
}

describe('detectLanguage', () => {
    it('ブラウザの言語が日本語なら ja、ほかは en', () => {
        expect(detectLanguage(['ja'])).toBe('ja');
        expect(detectLanguage(['ja-JP', 'en-US'])).toBe('ja');
        expect(detectLanguage(['JA-jp'])).toBe('ja');
        expect(detectLanguage(['en-US', 'ja'])).toBe('en');
        expect(detectLanguage(['fr'])).toBe('en');
        expect(detectLanguage(['jav'])).toBe('en');
        expect(detectLanguage([])).toBe('en');
    });
});

describe('loadLanguage', () => {
    it('覚えたものがあればそれを使う', () => {
        expect(loadLanguage(storageWith('en'), ['ja'])).toBe('en');
        expect(loadLanguage(storageWith('ja'), ['en-US'])).toBe('ja');
    });

    it('ない・知らない値・読めないときはブラウザの言語', () => {
        expect(loadLanguage(storageWith(null), ['ja-JP'])).toBe('ja');
        expect(loadLanguage(storageWith('de'), ['en-US'])).toBe('en');
        const broken = {
            getItem: () => {
                throw new Error('blocked');
            },
        };
        expect(loadLanguage(broken, ['ja'])).toBe('ja');
        expect(loadLanguage(null, ['en'])).toBe('en');
    });
});

describe('setLanguage', () => {
    const initial = getLanguage();
    afterEach(() => {
        setLanguage(initial);
        localStorage.removeItem(LANGUAGE_KEY);
    });

    it('覚えて、<html lang> を htmlLang に合わせ、購読しているものに知らせる', () => {
        const other = initial === 'ja' ? 'en' : 'ja';
        let calls = 0;
        const unsubscribe = subscribeLanguage(() => calls++);
        setLanguage(other);
        expect(getLanguage()).toBe(other);
        expect(localStorage.getItem(LANGUAGE_KEY)).toBe(other);
        expect(document.documentElement.lang).toBe(htmlLang(other));
        expect(calls).toBe(1);
        // 同じ言語なら何もしない
        setLanguage(other);
        expect(calls).toBe(1);
        unsubscribe();
    });

    it('ほかのタブで切り替えたら（storage のイベント）合わせる。保存はしない', () => {
        const other = initial === 'ja' ? 'en' : 'ja';
        let calls = 0;
        const unsubscribe = subscribeLanguage(() => calls++);
        window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: other }));
        expect(getLanguage()).toBe(other);
        expect(calls).toBe(1);
        expect(localStorage.getItem(LANGUAGE_KEY)).toBeNull();
        // ほかのキー・知らない値は見ない
        window.dispatchEvent(new StorageEvent('storage', { key: 'theme', newValue: initial }));
        window.dispatchEvent(new StorageEvent('storage', { key: LANGUAGE_KEY, newValue: 'de' }));
        expect(getLanguage()).toBe(other);
        expect(calls).toBe(1);
        unsubscribe();
    });
});

// <html lang> は表示言語（#497）。index.html の起動前のスクリプトも、loadLanguage と同じ決め方で付ける
describe('htmlLang', () => {
    const initialLang = document.documentElement.lang;
    afterEach(() => {
        localStorage.removeItem(LANGUAGE_KEY);
        vi.restoreAllMocks();
        document.documentElement.lang = initialLang;
    });

    it('表示言語をそのまま返す', () => {
        for (const language of languages) {
            expect(htmlLang(language)).toBe(language);
        }
    });

    it('index.html のスクリプトが付ける lang は、loadLanguage と同じ', () => {
        const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
        const cases: { saved: string | null; browser: string[] }[] = [
            { saved: null, browser: ['ja-JP', 'en-US'] },
            { saved: null, browser: ['en-US', 'ja'] },
            { saved: null, browser: ['JA'] },
            { saved: null, browser: ['jav'] },
            { saved: null, browser: [] },
            { saved: 'en', browser: ['ja'] },
            { saved: 'ja', browser: ['en-US'] },
            { saved: 'de', browser: ['ja'] },
        ];
        for (const { saved, browser } of cases) {
            if (saved === null) {
                localStorage.removeItem(LANGUAGE_KEY);
            } else {
                localStorage.setItem(LANGUAGE_KEY, saved);
            }
            vi.spyOn(navigator, 'languages', 'get').mockReturnValue(browser);
            vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser[0] ?? '');
            document.documentElement.lang = '';
            new Function(script)();
            expect({ saved, browser, lang: document.documentElement.lang }).toEqual({
                saved,
                browser,
                lang: htmlLang(loadLanguage(storageWith(saved), browser)),
            });
        }
    });
});
