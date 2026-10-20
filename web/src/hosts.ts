// クラウド版のホスト（文字起こしをする PC）の一覧・選択・管理（#161。spec/cloud.md 10.6）。ダイレクト版では使わない
import { create } from 'zustand';

import { request } from '@/account';
import { meUrl } from '@/endpoint';

export type Host = {
    id: string;
    name: string;
    appVersion: string | null;
    createdAt: number;
    lastSeenAt: number | null;
    // トンネルに cloudflared がつながっているか。分からないときは null
    online: boolean | null;
};

// 前に選んだホスト（この端末だけ）
const LAST_HOST_KEY = 'rw.cloud.lastHostId';

export function rememberHost(hostId: string) {
    try {
        localStorage.setItem(LAST_HOST_KEY, hostId);
    } catch {
        // 保存できなくても、選び直せばよい
    }
}

export function rememberedHost(): string | null {
    try {
        return localStorage.getItem(LAST_HOST_KEY);
    } catch {
        return null;
    }
}

// 選べるか（オフラインと分かっているものは選べない。分からないものは選べる）
export const selectable = (h: Host) => h.online !== false;

export type Pick = { kind: 'none' } | { kind: 'connect'; host: Host } | { kind: 'choose' };

// 一覧から、どうするかを決める
// - 0 台: 登録の案内
// - 選べるものが 1 台だけ（全体も 1 台）: 選ぶ画面を出さずにつなぐ
// - 前に選んだホストが選べる: それにつなぐ（つないでからも切り替えられる）
// - ほか: 選ぶ画面
export function pickHost(hosts: Host[], remembered: string | null): Pick {
    if (hosts.length === 0) {
        return { kind: 'none' };
    }
    if (hosts.length === 1 && selectable(hosts[0])) {
        return { kind: 'connect', host: hosts[0] };
    }
    const last = hosts.find((h) => h.id === remembered);
    if (last && selectable(last)) {
        return { kind: 'connect', host: last };
    }
    return { kind: 'choose' };
}

type HostsResponse = { hosts: Host[] };

export const fetchHosts = () => request<HostsResponse>(meUrl('/hosts')).then((r) => r.hosts);
export const renameHost = (id: string, name: string) =>
    request<HostsResponse>(meUrl(`/hosts/${encodeURIComponent(id)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    }).then((r) => r.hosts);
export const removeHost = (id: string) =>
    request<HostsResponse>(meUrl(`/hosts/${encodeURIComponent(id)}`), { method: 'DELETE' }).then((r) => r.hosts);

type HostsStore = {
    hosts: Host[] | null;
    error: string | null;
    // 自動でホストにつないだか（開いて最初の 1 回だけ自動でつなぐ。ログアウトで戻す）
    autoPicked: boolean;
    reset: () => void;
    load: () => Promise<Host[] | null>;
    set: (hosts: Host[]) => void;
};

export const useHostsStore = create<HostsStore>((set) => ({
    hosts: null,
    error: null,
    autoPicked: false,
    reset: () => set({ hosts: null, error: null, autoPicked: false }),
    load: async () => {
        try {
            const hosts = await fetchHosts();
            set({ hosts, error: null });
            return hosts;
        } catch (e) {
            set({ error: (e as Error).message });
            return null;
        }
    },
    set: (hosts) => set({ hosts }),
}));
