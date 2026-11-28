import { afterEach, describe, expect, it } from 'vitest';

import { httpErrorText, localizeServerMessage, serverErrorText } from '@/api/serverErrors/serverErrors';
import { setLanguage } from '@/i18n/language';

afterEach(() => {
    setLanguage('ja');
});

describe('serverErrorText', () => {
    it('コードの文に値を埋める（日本語はサーバーの文と同じ）', () => {
        expect(serverErrorText('session.notFound', { id: '20260101-000000' }, 'x')).toBe(
            'セッション 20260101-000000 はありません',
        );
        expect(serverErrorText('upload.tooLarge', { limitMb: 500 }, 'x')).toBe(
            'ファイルが大きすぎます（上限 500MB。設定で変えられます）',
        );
        expect(serverErrorText('lmstudio.paused', {}, 'x')).toBe(
            'LM Studio で一時停止されています。LM Studio の画面で再開してください',
        );
    });

    it('値のない文は params がなくても引ける', () => {
        expect(serverErrorText('upload.empty', undefined, 'x')).toBe('ファイルが空です');
    });

    it('知らないコード・コードなし・値が足りない・形が違うときは、サーバーの文をそのまま出す', () => {
        expect(serverErrorText('future.code', {}, 'サーバーの文')).toBe('サーバーの文');
        expect(serverErrorText(undefined, undefined, 'サーバーの文')).toBe('サーバーの文');
        expect(serverErrorText('session.notFound', {}, 'サーバーの文')).toBe('サーバーの文');
        expect(serverErrorText('session.notFound', { id: { x: 1 } }, 'サーバーの文')).toBe('サーバーの文');
        expect(serverErrorText('session.notFound', ['a'], 'サーバーの文')).toBe('サーバーの文');
        expect(serverErrorText('toString', {}, 'サーバーの文')).toBe('サーバーの文');
    });

    it('English では英語の文を出す（#497）', () => {
        setLanguage('en');
        expect(serverErrorText('upload.empty', {}, 'x')).toBe('The file is empty');
        expect(serverErrorText('session.notFound', { id: 'a' }, 'x')).toBe('Session a not found');
    });
});

describe('httpErrorText', () => {
    it('新しいサーバー: コードから引く', () => {
        expect(
            httpErrorText({ detail: 'セッション a はありません', code: 'session.notFound', params: { id: 'a' } }),
        ).toBe('セッション a はありません');
    });

    it('古いサーバー: detail をそのまま出す', () => {
        expect(httpErrorText({ detail: '古いサーバーの文' })).toBe('古いサーバーの文');
    });

    it('detail が文字列でなければ undefined（FastAPI の検証のエラーなど）', () => {
        expect(httpErrorText({ detail: [{ loc: ['body'] }] })).toBeUndefined();
        expect(httpErrorText(null)).toBeUndefined();
        expect(httpErrorText('x')).toBeUndefined();
    });
});

describe('localizeServerMessage', () => {
    it('error の message をコードから引き直す', () => {
        const m = localizeServerMessage({
            type: 'error',
            code: 'cannot_continue',
            message: '録音を終えてから 30 分を過ぎたので、続きを録音できません',
            messageCode: 'continue.expired',
            params: { minutes: '30' },
        });
        expect(m.message).toBe('録音を終えてから 30 分を過ぎたので、続きを録音できません');
        expect(m.code).toBe('cannot_continue');
    });

    it('messageCode のない error（古いサーバー）と、error でないものはそのまま', () => {
        const old = { type: 'error', code: 'bad_message', message: '古い文' };
        expect(localizeServerMessage(old)).toEqual(old);
        const other = { type: 'status', recordings: 0 };
        expect(localizeServerMessage(other)).toBe(other);
    });
});
