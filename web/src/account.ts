// クラウド版のアカウント（#155）。ログイン・ログイン手段・ログアウト・退会。ダイレクト版では使わない
import { create } from 'zustand';

import { authLoginUrl, authLogoutUrl, meUrl } from '@/endpoint';

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

// まだ足していないログインの手段
export function addableProviders(me: Me): Provider[] {
    const linked = new Set(me.identities.map((i) => i.provider));
    return me.providers.filter((p) => !linked.has(p));
}

// 外せるか（最後の 1 つは外せない）
export function canRemove(me: Me) {
    return me.identities.length > 1;
}

// 中間サーバーの API を呼ぶ（Cookie つき）。失敗したら、返事の detail を文にした Error（status つき）
export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(url, { credentials: 'same-origin', ...init });
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

export const logout = () => request<{ ok: boolean }>(authLogoutUrl(), { method: 'POST' });
export const removeIdentity = (id: string) =>
    request<Me>(meUrl(`/identities/${encodeURIComponent(id)}`), { method: 'DELETE' });
export const deleteAccount = () => request<{ ok: boolean }>(meUrl(), { method: 'DELETE' });

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
