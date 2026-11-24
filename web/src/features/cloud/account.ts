// クラウド版のアカウント（#155）。ログイン・ログイン手段・ログアウト・退会。セルフホスト版では使わない
import { create } from 'zustand';

import { appForget, appLogout, withAppAuth } from '@/api/appAuth';
import { authLoginUrl, authLogoutUrl, meUrl } from '@/api/endpoint';

export type Provider = 'google' | 'discord' | 'github';

export const PROVIDER_LABELS: Record<Provider, string> = {
    google: 'Google',
    discord: 'Discord',
    github: 'GitHub',
};

export type Identity = {
    id: string;
    provider: Provider;
    email: string | null;
    displayName: string | null;
    createdAt: number;
};

export type Me = {
    id: string;
    displayName: string;
    // 初めに同意した利用規約の版。同意する前は null（#162）
    tosVersion: string | null;
    // 今の利用規約の版と、規約・プライバシーポリシーのリンク先
    tosCurrent: string;
    termsUrl: string;
    privacyUrl: string;
    // データ収集の今の許可（初回の同意で許可する。画面からは変えない）
    dataCollection: boolean;
    identities: Identity[];
    providers: Provider[];
};

// ログインを始める URL。link は、ログインしている人がログイン手段を足すとき。returnTo はログインのあとに戻るパス
export function loginHref(provider: Provider, opts: { link?: boolean; returnTo?: string } = {}) {
    const params = new URLSearchParams();
    if (opts.link) {
        params.set('link', '1');
    }
    if (opts.returnTo) {
        params.set('return', opts.returnTo);
    }
    const query = params.toString();
    return query ? `${authLoginUrl(provider)}?${query}` : authLoginUrl(provider);
}

// 初回の同意で送る本文（今の規約の版に同意する）
export function consentPayload(me: Me, dataCollection: boolean) {
    return { tosVersion: me.tosCurrent, dataCollection };
}

// 「同意して進む」を押せるか（規約にチェックを入れていて、送っている途中でないとき）
export function canSubmitConsent(agreed: boolean, busy: boolean) {
    return agreed && !busy;
}

// まだ足していないログインの手段
export function addableProviders(me: Me): Provider[] {
    const linked = new Set(me.identities.map((i) => i.provider));
    return me.providers.filter((p) => !linked.has(p));
}

// 外せるか（最後の 1 つは外せない）
export function canRemove(me: Me) {
    return me.identities.length > 1;
}

// 中間サーバーの API を呼ぶ（Cookie つき。アプリの中ではアプリのトークンも。#441）。
// 失敗したら、返事の detail を文にした Error（status つき）
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, await withAppAuth(url, { credentials: 'same-origin', ...init }));
    if (!res.ok) {
        const detail = await res
            .json()
            .then((b: { detail?: string }) => b.detail)
            .catch(() => undefined);
        throw Object.assign(new Error(detail ?? `${res.status}`), { status: res.status });
    }
    return (await res.json()) as T;
}

// ログインしていれば自分の情報、していなければ null
export async function fetchMe(): Promise<Me | null> {
    try {
        return await request<Me>(meUrl());
    } catch (e) {
        if ((e as { status?: number }).status === 401) {
            return null;
        }
        throw e;
    }
}

// ログアウト。アプリの中では、先にアプリのトークン（この端末）を消す。Cookie のログインセッションも消す
// （server.url の WebView に前からの Cookie が残っていることがあるため。同梱した画面からは、/auth/ に CORS がないので
// fetch が失敗する（TypeError）。どちらも呼ぶ側が握りつぶす）
export async function logout() {
    await appLogout().catch(() => undefined);
    return request<{ ok: boolean }>(authLogoutUrl(), { method: 'POST' });
}
// すべての端末からログアウト（#250）。今の端末も含む（アプリの端末も。中間サーバーで消えるので、アプリの中のトークンも消す）
export async function logoutEverywhere() {
    const result = await request<{ ok: boolean }>(meUrl('/sessions'), { method: 'DELETE' });
    await appForget().catch(() => undefined);
    return result;
}
export const removeIdentity = (id: string) =>
    request<Me>(meUrl(`/identities/${encodeURIComponent(id)}`), { method: 'DELETE' });
const jsonInit = (method: string, body: unknown): RequestInit => ({
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});
export const postConsent = (me: Me, dataCollection: boolean) =>
    request<{ ok: boolean }>(meUrl('/consent'), jsonInit('POST', consentPayload(me, dataCollection)));
export async function deleteAccount() {
    const result = await request<{ ok: boolean }>(meUrl(), { method: 'DELETE' });
    await appForget().catch(() => undefined);
    return result;
}

// アプリの端末（#441。アプリでログインした端末）。中間サーバーの /me/devices
export type Device = { id: string; name: string; createdAt: number; lastSeenAt: number; current: boolean };
export const fetchDevices = () => request<{ devices: Device[] }>(meUrl('/devices')).then((r) => r.devices);
export const removeDevice = (id: string) =>
    request<{ devices: Device[] }>(meUrl(`/devices/${encodeURIComponent(id)}`), { method: 'DELETE' }).then(
        (r) => r.devices,
    );

type AccountStore = {
    me: Me | null;
    // 最初の確かめが済んだか（済むまではログインの画面を出さない）
    checked: boolean;
    setMe: (me: Me | null) => void;
};

export const useAccountStore = create<AccountStore>((set) => ({
    me: null,
    checked: false,
    setMe: (me) => set({ me, checked: true }),
}));
