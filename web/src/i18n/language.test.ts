import { afterEach, describe, expect, it } from 'vitest';

import { LANGUAGE_KEY, detectLanguage, getLanguage, loadLanguage, setLanguage, subscribeLanguage } from './language';

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

    it('覚えて、<html lang> を合わせ、購読しているものに知らせる', () => {
        const other = initial === 'ja' ? 'en' : 'ja';
        let calls = 0;
        const unsubscribe = subscribeLanguage(() => calls++);
        setLanguage(other);
        expect(getLanguage()).toBe(other);
        expect(localStorage.getItem(LANGUAGE_KEY)).toBe(other);
        expect(document.documentElement.lang).toBe(other);
        expect(calls).toBe(1);
        // 同じ言語なら何もしない
        setLanguage(other);
        expect(calls).toBe(1);
        unsubscribe();
    });
});
