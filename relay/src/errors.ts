// web の画面に届くエラーのコード（#495。spec/cloud.md 10.4 節の「エラーのコード」）。サーバーのエラー（#494。spec/api.md 7.6）と同じ形で、
// 本文は {"detail": 日本語の文, "code": コード, "params": 値}。web はコードから辞書
// （web/src/api/relayErrors/i18n/）を引いて表示言語の文を出す。辞書の文はここの文と同じにする
// （test/errors.test.ts が突き合わせる）。英語の文は spec/i18n.md の用語集に合わせる
import { json } from './http';

type Params = Record<string, string | number>;
export type Language = 'ja' | 'en';

export const ERRORS = {
    'request.tooLarge': { ja: '大きすぎます', en: 'Too large' },
    'request.tooMany': {
        ja: '送りすぎです。しばらくしてからにしてください',
        en: 'Too many requests. Try again later',
    },
    'login.required': { ja: 'ログインしてください', en: 'Log in' },
    'login.retry': { ja: 'ログインをやり直してください', en: 'Log in again' },
    'login.badAppRequest': {
        ja: 'ログインをやり直してください（アプリから始めたログインの形が違います）',
        en: 'Log in again (the login started from the app is malformed)',
    },
    'login.noState': {
        ja: 'ログインをやり直してください（state がありません）',
        en: 'Log in again (the state is missing)',
    },
    'login.otherBrowser': {
        ja: 'ログインをやり直してください（このブラウザで始めたログインではありません）',
        en: 'Log in again (the login was not started in this browser)',
    },
    'login.stateExpired': {
        ja: 'ログインをやり直してください（期限が切れたか、使い終わった state です）',
        en: 'Log in again (the state has expired or was already used)',
    },
    'login.userChanged': {
        ja: 'ログインをやり直してください（ログインしているユーザーが変わりました）',
        en: 'Log in again (the logged-in user has changed)',
    },
    'login.failed': {
        ja: 'ログインできませんでした。もう一度試してください',
        en: "Couldn't log in. Try again",
    },
    'loginMethod.unknown': { ja: 'ログインの手段がありません', en: 'No such login method' },
    'loginMethod.unavailable': {
        ja: 'このログインの手段は、まだ使えません',
        en: "This login method isn't available yet",
    },
    'loginMethod.usedByOtherUser': {
        ja: 'このアカウントは、ほかのユーザーのログイン手段になっています',
        en: 'This account is already a login method of another user',
    },
    'loginMethod.notFound': { ja: 'そのログイン手段はありません', en: 'Login method not found' },
    'loginMethod.lastOne': { ja: '最後のログイン手段は外せません', en: "You can't remove your last login method" },
    'appToken.badGrantType': { ja: 'grantType が違います', en: 'Invalid grantType' },
    'appTicket.appOnly': { ja: 'アプリからだけ使えます', en: 'Only available from the iOS app' },
    'appTicket.invalid': { ja: 'チケットの形が違います', en: 'Invalid ticket' },
    'device.notFound': { ja: 'その端末はありません', en: 'Device not found' },
    'consent.badRequest': {
        ja: 'tosVersion（文字列）と dataCollection（真偽値）が必要です',
        en: 'tosVersion (string) and dataCollection (boolean) are required',
    },
    'consent.termsChanged': {
        ja: '利用規約の版が変わりました。画面を開き直してください',
        en: 'The terms of service have changed. Reopen the page',
    },
    'consent.alreadyAgreed': { ja: 'すでに同意済みです', en: 'You have already agreed' },
    'consent.required': {
        ja: '先に利用規約に同意してください',
        en: 'Agree to the terms of service first',
    },
    'dataCollection.badRequest': { ja: 'granted（真偽値）が必要です', en: 'granted (boolean) is required' },
    'cloudHost.badName': { ja: '名前は 1〜{max} 文字にしてください', en: 'The name must be 1 to {max} characters' },
    'cloudHost.notFound': { ja: 'そのホストはありません', en: 'Host not found' },
    'cloudHost.forbidden': { ja: 'このホストにはつなげません', en: "You can't connect to this host" },
    'cloudHost.unreachable': {
        ja: 'ホストにつながりません（PC が起動しているか確かめてください）',
        en: "Can't reach the host (check that the PC is on)",
    },
    'cloudHost.tooMany': {
        ja: 'ホストは {max} 台まで登録できます。使っていないホストを外してください',
        en: "You can register up to {max} hosts. Remove hosts you don't use",
    },
    'tunnel.notReady': { ja: 'ホストのトンネルがまだできていません', en: "The host's tunnel isn't ready yet" },
    'tunnel.keyUnreadable': {
        ja: 'ホストの中継の鍵が読めません。登録し直してください',
        en: "Can't read the host's relay key. Register the host again",
    },
    'pairing.badCode': { ja: '登録コードの形が違います', en: 'Invalid registration code' },
    'pairing.notFoundMaybeExpired': {
        ja: '登録の申請が見つかりません（期限が切れたかもしれません）',
        en: 'Registration request not found (it may have expired)',
    },
    'pairing.notFound': { ja: '登録の申請が見つかりません', en: 'Registration request not found' },
    'release.notFound': { ja: 'リリースがありません', en: 'No release' },
} as const satisfies Record<string, Record<Language, string>>;

export type ErrorCode = keyof typeof ERRORS;

// code の文に params を埋める
export function errorText(code: ErrorCode, params: Params = {}, language: Language = 'ja'): string {
    return ERRORS[code][language].replace(/\{(\w+)\}/g, (all, name: string) =>
        Object.hasOwn(params, name) ? String(params[name]) : all,
    );
}

// コードつきのエラー。detail は、古い web（コードを知らない）のために日本語の文。
// ブラウザが直に開くページ（ログインの遷移）だけ、language で Accept-Language の言語にする（pageError）
export function apiError(status: number, code: ErrorCode, params: Params = {}, language: Language = 'ja'): Response {
    return json({ detail: errorText(code, params, language), code, params }, status);
}

// Accept-Language で選ぶ言語。いちばん好まれる言語が日本語か、ヘッダーがない・* なら ja、ほかは en
// （web の表示言語の初期値と同じ考え方。web/README.md の「表示言語（i18n）」）
export function preferredLanguage(request: Request): Language {
    const header = request.headers.get('Accept-Language');
    if (!header) {
        return 'ja';
    }
    let best: { tag: string; q: number } | null = null;
    for (const part of header.split(',')) {
        const [rawTag, ...rest] = part.trim().split(';');
        const tag = rawTag.trim().toLowerCase();
        const qParam = rest.map((p) => p.trim()).find((p) => p.startsWith('q='));
        const q = qParam === undefined ? 1 : Number(qParam.slice(2));
        if (tag === '' || !Number.isFinite(q) || q <= 0) {
            continue;
        }
        if (best === null || q > best.q) {
            best = { tag, q };
        }
    }
    if (best === null || best.tag === '*' || best.tag === 'ja' || best.tag.startsWith('ja-')) {
        return 'ja';
    }
    return 'en';
}

// ブラウザが直に開くページ（/auth/login・/auth/callback・/auth/app/login）のエラー。web が文を引けないので、
// detail を Accept-Language の言語にする（日本語のときの文は apiError と同じ）。言語で中身が変わるので Vary を付ける
export function pageError(request: Request, status: number, code: ErrorCode, params: Params = {}): Response {
    const response = apiError(status, code, params, preferredLanguage(request));
    response.headers.set('Vary', 'Accept-Language');
    return response;
}
