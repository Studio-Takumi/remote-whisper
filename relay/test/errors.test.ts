// エラーのコード（#495。spec/cloud.md 10.4 節の「エラーのコード」）。server/tests/test_error_dictionary.py（#494）と同じ考えで、
// relay の文（src/errors.ts）と web の辞書（web/src/api/relayErrors/i18n/）を突き合わせる。
// web はコードから辞書の文を引くので、日本語の文が relay の detail と違うと、表示が変わってしまう
import { SELF, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ERRORS, type ErrorCode, errorText, preferredLanguage } from '../src/errors';

// 'key': '文' と "key": "文"（文に ' が入ると prettier が "..." にする）
const ENTRY = /(['"])([a-zA-Z]+\.[a-zA-Z]+)\1:\s*(['"])((?:(?!\3).)*)\3/gs;
// 行の頭のキー（読めたキーの数と比べる）
const KEY = /^\s*(['"])[a-zA-Z]+\.[a-zA-Z]+\1:/gm;

function readDictionary(text: string): Record<string, string> {
    const entries = Object.fromEntries([...text.matchAll(ENTRY)].map((m) => [m[2], m[4]]));
    expect(Object.keys(entries).length, '辞書のキーのうち読めないものがあります').toBe(text.match(KEY)?.length ?? 0);
    return entries;
}

const codes = Object.keys(ERRORS) as ErrorCode[];
const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe.skipIf(env.TEST_WEB_ERRORS_JA === '')('web の辞書', () => {
    it('日本語の文が relay と同じ', () => {
        const ja = readDictionary(env.TEST_WEB_ERRORS_JA);
        expect(ja).toEqual(Object.fromEntries(codes.map((code) => [code, ERRORS[code].ja])));
    });

    it('英語の文が relay と同じ', () => {
        const en = readDictionary(env.TEST_WEB_ERRORS_EN);
        expect(en).toEqual(Object.fromEntries(codes.map((code) => [code, ERRORS[code].en])));
    });
});

// errors.ts（文の置き場所）を除いた src
const source = Object.entries(env.TEST_RELAY_SOURCE).filter(([name]) => name !== 'errors.ts');

// コメントを外す（/* */ と、行の頭か空白のあとの //。'https://…' の // は外さない）
const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

// 日本語を書いてよい文字列（エラーの文ではないもの）。足すときは理由も書く
const JAPANESE_ALLOWED = new Set([
    // アプリの端末の名前の初期値（appAuth.ts）。D1 に保存するデータで、画面の文ではない
    'iOS アプリ',
]);

describe('relay の文', () => {
    it('どのコードも src で使っている', () => {
        const unused = codes.filter((code) => !source.some(([, text]) => text.includes(`'${code}'`)));
        expect(unused).toEqual([]);
    });

    it('コメント以外の文字列に日本語を書いていない（エラーは errors.ts のコードで返す）', () => {
        const japanese = /[぀-ヿ一-鿿]/;
        const found = source.flatMap(([name, text]) =>
            [...withoutComments(text).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)]
                .map((m) => m[2])
                .filter((literal) => japanese.test(literal) && !JAPANESE_ALLOWED.has(literal))
                .map((literal) => `${name}: ${literal}`),
        );
        expect(found).toEqual([]);
    });

    it('日本語を書いていないかの確かめは、書いてあれば見つける', () => {
        const sample = [
            "return error(status, 'ログインしてください');",
            "return new Response('見つかりません', { status: 404 });",
            '// コメントの日本語は見ない',
            "const url = 'https://rw.example/'; // ここも見ない",
        ].join('\n');
        const literals = [...withoutComments(sample).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
        expect(literals).toEqual(['ログインしてください', '見つかりません', 'https://rw.example/']);
    });

    it('日本語と英語で {} の名前が同じ', () => {
        const different = codes.filter(
            (code) => placeholders(ERRORS[code].ja).join() !== placeholders(ERRORS[code].en).join(),
        );
        expect(different).toEqual([]);
    });

    it('{} に params を埋める', () => {
        expect(errorText('cloudHost.tooMany', { max: 5 })).toBe(
            'ホストは 5 台まで登録できます。使っていないホストを外してください',
        );
        expect(errorText('cloudHost.badName', { max: 64 }, 'en')).toBe('The name must be 1 to 64 characters');
    });
});

describe('preferredLanguage', () => {
    const lang = (value: string | null) =>
        preferredLanguage(
            new Request('https://rw.example/', value === null ? {} : { headers: { 'Accept-Language': value } }),
        );

    it('ヘッダーがない・日本語がいちばん・* なら ja', () => {
        expect(lang(null)).toBe('ja');
        expect(lang('')).toBe('ja');
        expect(lang('ja')).toBe('ja');
        expect(lang('ja-JP,ja;q=0.9,en;q=0.8')).toBe('ja');
        expect(lang('en;q=0.5,ja;q=0.9')).toBe('ja');
        expect(lang('*')).toBe('ja');
    });

    it('ほかの言語がいちばんなら en（web の表示言語の初期値と同じ）', () => {
        expect(lang('en-US,en;q=0.9,ja;q=0.8')).toBe('en');
        expect(lang('fr-FR')).toBe('en');
        expect(lang('ja;q=0,en')).toBe('en');
    });
});

describe('返す形', () => {
    it('API は Accept-Language にかかわらず日本語の detail と code・params（古い web のため）', async () => {
        const res = await SELF.fetch('https://rw-dev.example/me', { headers: { 'Accept-Language': 'en' } });
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ detail: 'ログインしてください', code: 'login.required', params: {} });
    });

    it('中継（/h/）のエラーも同じ形', async () => {
        const res = await SELF.fetch(`https://rw-dev.example/h/${crypto.randomUUID()}/api/sessions`);
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ detail: 'ログインしてください', code: 'login.required', params: {} });
    });

    it('ブラウザが直に開くログインのページは、Accept-Language の言語の detail', async () => {
        const open = (language?: string) =>
            SELF.fetch(
                'https://rw-dev.example/auth/login/nope',
                language === undefined ? {} : { headers: { 'Accept-Language': language } },
            );
        const en = await open('en-US,en;q=0.9');
        expect(en.status).toBe(404);
        expect(en.headers.get('Vary')).toBe('Accept-Language');
        expect(await en.json()).toEqual({ detail: 'No such login method', code: 'loginMethod.unknown', params: {} });
        // 日本語のときと、ヘッダーがないときは今まで通りの文
        for (const language of ['ja', undefined]) {
            expect(await (await open(language)).json()).toEqual({
                detail: 'ログインの手段がありません',
                code: 'loginMethod.unknown',
                params: {},
            });
        }
    });

    it('コールバックの state の確かめも、Accept-Language の言語', async () => {
        const res = await SELF.fetch('https://rw-dev.example/auth/callback/google?code=x', {
            headers: { 'Accept-Language': 'en' },
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
            detail: 'Log in again (the state is missing)',
            code: 'login.noState',
        });
    });
});
