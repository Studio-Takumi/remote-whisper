// ホストの登録の確認（#157。spec/cloud.md 10.6）。トレイが開いた /pair?code=… の画面で使う。ダイレクト版では使わない
import { request } from '@/account';
import { pairUrl } from '@/endpoint';

export type PairRequest = {
    code: string;
    hostName: string;
    status: 'pending' | 'approved' | 'rejected';
    // 承認・拒否したのが自分か（まだなら null）
    answeredByMe: boolean | null;
    expiresAt: number;
};

// 開いている画面が登録の確認か。そうならコード（そろえる前のまま）
export function pairingCode(loc: { pathname: string; search: string }): string | null {
    if (loc.pathname !== '/pair') {
        return null;
    }
    return new URLSearchParams(loc.search).get('code');
}

const post = <T>(path: string, code: string) =>
    request<T>(pairUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });

export const fetchPairRequest = (code: string) =>
    request<PairRequest>(`${pairUrl('request')}?${new URLSearchParams({ code }).toString()}`);
export const approvePairing = (code: string) =>
    post<{ ok: boolean; hostId: string; hostName: string }>('approve', code);
export const rejectPairing = (code: string) => post<{ ok: boolean }>('reject', code);
