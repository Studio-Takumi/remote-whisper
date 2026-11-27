// サーバーのエラーの文を、コードから表示言語で引く（#494。spec/api.md 7.6）。
// サーバーはコード（HTTP は code、WebSocket の error は messageCode）と文に埋める値（params）に、
// 移行期間のための日本語の文（HTTP は detail、WebSocket は message）を添えて返す。
// 知らないコード（新しいサーバー）・コードがない（古いサーバー）・値が足りないときは、日本語の文をそのまま出す
import { serverErrorMessages } from '@/api/serverErrors/i18n';
import { ja } from '@/api/serverErrors/i18n/ja';

type Params = Record<string, string | number>;

const translate = serverErrorMessages.t as (key: string, params?: Params) => string;

function isParams(value: unknown): value is Params {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.values(value).every((v) => typeof v === 'string' || typeof v === 'number')
    );
}

// code の文に params を埋める。引けなければ fallback
export function serverErrorText(code: unknown, params: unknown, fallback: string): string {
    if (typeof code !== 'string' || !Object.hasOwn(ja, code)) {
        return fallback;
    }
    const values = params === undefined ? {} : params;
    if (!isParams(values)) {
        return fallback;
    }
    const template: string = ja[code as keyof typeof ja];
    const names = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    if (!names.every((name) => Object.hasOwn(values, name))) {
        return fallback;
    }
    return translate(code, values);
}

// HTTP のエラーの本文（JSON を読んだもの）から、出す文。detail が文字列でなければ undefined
export function httpErrorText(body: unknown): string | undefined {
    if (typeof body !== 'object' || body === null) {
        return undefined;
    }
    const { detail, code, params } = body as { detail?: unknown; code?: unknown; params?: unknown };
    return typeof detail === 'string' ? serverErrorText(code, params, detail) : undefined;
}

// WebSocket で届いたメッセージ。error なら message を表示言語の文にする（ほかはそのまま）
export function localizeServerMessage<M extends { type: string }>(message: M): M {
    if (message.type !== 'error') {
        return message;
    }
    const {
        message: text,
        messageCode,
        params,
    } = message as M & {
        message?: unknown;
        messageCode?: unknown;
        params?: unknown;
    };
    if (typeof text !== 'string') {
        return message;
    }
    return { ...message, message: serverErrorText(messageCode, params, text) };
}
