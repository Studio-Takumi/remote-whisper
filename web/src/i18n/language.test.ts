import { afterEach, describe, expect, it } from 'vitest';

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

// 英訳（#497）までは <html lang> を ja のまま止める（lang="en" の日本語は中国語の字形になりうるため）。
// #497 で htmlLang を替えたら、index.html でも描く前に表示言語で lang を付ける（そうしないとこのテストが落ちる）
describe('htmlLang', () => {
    it('どの表示言語でも、index.html の <html lang> と同じ', () => {
        const staticLang = /<html lang="([^"]+)">/.exec(html)?.[1];
        for (const language of languages) {
            expect(htmlLang(language)).toBe(staticLang);
        }
    });
});
