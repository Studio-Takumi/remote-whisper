import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LANGUAGE_KEY, getLanguage, setLanguage } from './language';
import { defineDictionary, defineMessages, defineTranslation, useT } from './messages';

const ja = defineDictionary({
    'sample.title': '設定',
    'sample.left': 'あと {n} 分',
    'sample.pair': '{a} と {b}',
    'sample.items': '{n} 件',
    'sample.count': (p: { n: number }) => `${p.n} 件`,
});

const en = defineTranslation<typeof ja>()({
    'sample.title': 'Settings',
    'sample.pair': '{b} and {a}',
    // ja は文字列のまま、en だけ単数・複数を分ける
    'sample.items': (p) => (p.n === 1 ? '1 item' : `${p.n} items`),
    'sample.count': (p) => (p.n === 1 ? '1 thing' : `${p.n} things`),
});

const messages = defineMessages({ ja, en });

describe('defineMessages', () => {
    it('ja はそのまま、引数を埋める', () => {
        expect(messages.translate('ja', 'sample.title')).toBe('設定');
        expect(messages.translate('ja', 'sample.left', { n: 3 })).toBe('あと 3 分');
        expect(messages.translate('ja', 'sample.pair', { a: 'A', b: 'B' })).toBe('A と B');
        expect(messages.translate('ja', 'sample.items', { n: 2 })).toBe('2 件');
        expect(messages.translate('ja', 'sample.count', { n: 2 })).toBe('2 件');
    });

    it('en にあるものは en、ないキーは ja の文を出す', () => {
        expect(messages.translate('en', 'sample.title')).toBe('Settings');
        expect(messages.translate('en', 'sample.pair', { a: 'A', b: 'B' })).toBe('B and A');
        expect(messages.translate('en', 'sample.items', { n: 1 })).toBe('1 item');
        expect(messages.translate('en', 'sample.items', { n: 3 })).toBe('3 items');
        expect(messages.translate('en', 'sample.count', { n: 1 })).toBe('1 thing');
        expect(messages.translate('en', 'sample.left', { n: 5 })).toBe('あと 5 分');
    });

    it('t のキーと引数を型で確かめる', () => {
        // @ts-expect-error 辞書にないキー
        messages.translate('ja', 'sample.titel');
        // @ts-expect-error 埋めるものがあるのに引数がない
        messages.translate('ja', 'sample.left');
        // @ts-expect-error 引数の名前の打ち間違い
        messages.translate('ja', 'sample.left', { m: 3 });
        // @ts-expect-error 埋めるものがないのに引数がある
        messages.translate('ja', 'sample.title', { n: 1 });
    });

    it('en のキーと {} を ja と突き合わせる', () => {
        const translate = defineTranslation<typeof ja>();
        // @ts-expect-error ja にないキー
        translate({ 'sample.other': 'x' });
        // @ts-expect-error ほかのキーと一緒でも、ja にないキーは止まる
        translate({ 'sample.title': 'Settings', 'sample.other': 'x' });
        // @ts-expect-error {} の名前が ja と違う
        translate({ 'sample.left': '{m} min left' });
        // @ts-expect-error ja にある {} がない
        translate({ 'sample.left': 'a few min left' });
        // @ts-expect-error ja にない {} がある
        translate({ 'sample.title': 'Settings {x}' });
        // @ts-expect-error 埋めるもののない文を関数にはできない（引数が来ない）
        translate({ 'sample.title': () => 'Settings' });
        // @ts-expect-error 関数の引数は ja の {} から決まる
        translate({ 'sample.items': (p: { count: number }) => `${p.count} items` });
        expect(translate({ 'sample.left': '{n} min left' })).toEqual({ 'sample.left': '{n} min left' });
    });

    it('ja の文が string に広がっていると止まる（defineDictionary の付け忘れ）', () => {
        const widened: Record<'sample.left', string> = { 'sample.left': 'あと {n} 分' };
        // @ts-expect-error 広がった ja では {n} を確かめられない
        expect(defineMessages({ ja: widened, en: {} })).toBeDefined();
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

    it('react-dom/server で描いても動く（getServerSnapshot がある）', () => {
        act(() => setLanguage('ja'));
        const View = () => createElement('span', null, useT(messages)('sample.title'));
        expect(renderToString(createElement(View))).toContain('設定');
    });
});
