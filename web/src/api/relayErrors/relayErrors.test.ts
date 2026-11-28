// 中間サーバー（relay）のエラーの文（#495）。引くのは api/serverErrors/serverErrors.ts。
// 辞書の文が relay の文と同じかは relay/test/errors.test.ts が確かめる
import { afterEach, describe, expect, it } from 'vitest';

import { ja as relayJa } from '@/api/relayErrors/i18n/ja';
import { ja as serverJa } from '@/api/serverErrors/i18n/ja';
import { httpErrorText, serverErrorText } from '@/api/serverErrors/serverErrors';
import { setLanguage } from '@/i18n/language';

afterEach(() => {
    setLanguage('ja');
});

describe('relay のエラー', () => {
    it('コードから引く（日本語は relay の detail と同じ）', () => {
        expect(httpErrorText({ detail: 'ログインしてください', code: 'login.required', params: {} })).toBe(
            'ログインしてください',
        );
        expect(serverErrorText('cloudHost.tooMany', { max: 5 }, 'x')).toBe(
            'ホストは 5 台まで登録できます。使っていないホストを外してください',
        );
    });

    it('English では英語の文', () => {
        setLanguage('en');
        expect(serverErrorText('cloudHost.tooMany', { max: 5 }, 'x')).toBe(
            "You can register up to 5 hosts. Remove hosts you don't use",
        );
        expect(serverErrorText('login.required', {}, 'x')).toBe('Log in');
    });

    it('古い relay（コードなし）・知らないコード・値が足りないときは detail をそのまま', () => {
        expect(httpErrorText({ detail: '古い relay の文' })).toBe('古い relay の文');
        expect(httpErrorText({ detail: '新しい relay の文', code: 'host.future', params: {} })).toBe(
            '新しい relay の文',
        );
        expect(serverErrorText('cloudHost.tooMany', {}, 'relay の文')).toBe('relay の文');
    });

    it('サーバーのエラーのコードと重ならない（どちらの辞書を引くかが決まるように）', () => {
        const shared = Object.keys(relayJa).filter((code) => Object.hasOwn(serverJa, code));
        expect(shared).toEqual([]);
    });
});
