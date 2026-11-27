import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LANGUAGE_KEY, getLanguage, setLanguage } from './language';
import { type Dictionary, type Translation, defineMessages, useT } from './messages';

const ja = {
    'sample.title': '設定',
    'sample.left': 'あと {n} 分',
    'sample.pair': '{a} と {b}',
    'sample.count': (p: { n: number }) => `${p.n} 件`,
} as const satisfies Dictionary;

const en: Translation<typeof ja> = {
    'sample.title': 'Settings',
    'sample.count': (p) => (p.n === 1 ? '1 item' : `${p.n} items`),
};

const messages = defineMessages({ ja, en });

describe('defineMessages', () => {
    it('ja はそのまま、引数を埋める', () => {
        expect(messages.translate('ja', 'sample.title')).toBe('設定');
        expect(messages.translate('ja', 'sample.left', { n: 3 })).toBe('あと 3 分');
        expect(messages.translate('ja', 'sample.pair', { a: 'A', b: 'B' })).toBe('A と B');
        expect(messages.translate('ja', 'sample.count', { n: 2 })).toBe('2 件');
    });

    it('en にあるものは en、ないキーは ja の文を出す', () => {
        expect(messages.translate('en', 'sample.title')).toBe('Settings');
        expect(messages.translate('en', 'sample.count', { n: 1 })).toBe('1 item');
        expect(messages.translate('en', 'sample.count', { n: 3 })).toBe('3 items');
        expect(messages.translate('en', 'sample.left', { n: 5 })).toBe('あと 5 分');
    });

    it('キーと引数を型で確かめる', () => {
        // @ts-expect-error 辞書にないキー
        messages.translate('ja', 'sample.titel');
        // @ts-expect-error 埋めるものがあるのに引数がない
        messages.translate('ja', 'sample.left');
        // @ts-expect-error 引数の名前の打ち間違い
        messages.translate('ja', 'sample.left', { m: 3 });
        // @ts-expect-error 埋めるものがないのに引数がある
        messages.translate('ja', 'sample.title', { n: 1 });
        // @ts-expect-error en に ja にないキー
        const wrong: Translation<typeof ja> = { 'sample.other': 'x' };
        expect(wrong).toBeDefined();
    });
});

describe('t と useT', () => {
    const initial = getLanguage();
    afterEach(() => {
        act(() => setLanguage(initial));
        localStorage.removeItem(LANGUAGE_KEY);
    });

    it('今の表示言語で引き、切り替えると描き直す', () => {
        act(() => setLanguage('ja'));
        const { result } = renderHook(() => useT(messages));
        expect(result.current('sample.title')).toBe('設定');
        expect(messages.t('sample.title')).toBe('設定');
        act(() => setLanguage('en'));
        expect(result.current('sample.title')).toBe('Settings');
        expect(messages.t('sample.title')).toBe('Settings');
    });
});
