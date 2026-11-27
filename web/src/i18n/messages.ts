import { useMemo } from 'react';

import { type Language, getLanguage, useLanguage } from '@/i18n/language';

// 画面ごとの辞書（#487）。置き場所とキーの付け方は web/README.md の「表示言語（i18n）」
// 文の値は文字列（{name} を引数で埋める）か、引数から文を作る関数（英語の単数・複数など）

// 辞書の値の形。関数の引数はどの形でもよい（使う側の型は値から決まる）
export type Dictionary = Readonly<Record<string, string | ((params: never) => string)>>;

// 'あと {n} 分' → 'n'
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;

// キーごとの、t() の 2 つ目の引数。埋めるものがなければ引数なし
type ArgsOf<M> = M extends (params: infer P) => string
    ? [params: P]
    : M extends string
      ? [Placeholders<M>] extends [never]
          ? []
          : [params: Record<Placeholders<M>, string | number>]
      : never;

// ja 以外の辞書。キーは ja と同じものだけ（打ち間違いは型で分かる）。ないキーは ja の文を出す
export type Translation<D extends Dictionary> = {
    readonly [K in keyof D]?: D[K] extends string ? string : D[K];
};

export type Translate<D extends Dictionary> = <K extends keyof D & string>(key: K, ...args: ArgsOf<D[K]>) => string;

export interface Messages<D extends Dictionary> {
    // 今の表示言語で引く。React の外（ストア・トーストなど）でも使える。部品の中では useT を使う
    t: Translate<D>;
    // 言語を決めて引く（テスト・言語を指定して出すとき）
    translate: <K extends keyof D & string>(language: Language, key: K, ...args: ArgsOf<D[K]>) => string;
}

// 画面の辞書を 1 つにまとめる。ja はすべての文を持つ。en はまだ訳していないキーを省いてよい
export function defineMessages<D extends Dictionary>(dictionaries: { ja: D; en: Translation<D> }): Messages<D> {
    const translate = <K extends keyof D & string>(language: Language, key: K, ...args: ArgsOf<D[K]>): string => {
        const own = language === 'ja' ? undefined : dictionaries[language][key];
        const message = own ?? dictionaries.ja[key];
        return format(message, args[0] as Readonly<Record<string, unknown>> | undefined);
    };
    return {
        translate,
        t: (key, ...args) => translate(getLanguage(), key, ...args),
    };
}

// 部品の中で使う。表示言語を切り替えると描き直す
export function useT<D extends Dictionary>(messages: Messages<D>): Translate<D> {
    const language = useLanguage();
    return useMemo<Translate<D>>(
        () =>
            (key, ...args) =>
                messages.translate(language, key, ...args),
        [messages, language],
    );
}

function format(message: Dictionary[string], params: Readonly<Record<string, unknown>> | undefined): string {
    if (typeof message === 'function') {
        return (message as (params: unknown) => string)(params);
    }
    if (!params) {
        return message;
    }
    // 引数にないものは {name} のまま残す（抜けに気づけるように）
    return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole));
}
