// アプリの中のクラウド版で、トークン・チケットを使う側（#441）。ログアウト・退会のあとのトークンの片付け、
// アップロードの Authorization、WebSocket のチケット付きの URL
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
    appLogout: vi.fn(),
    appForget: vi.fn(),
    appSocketUrl: vi.fn(),
    order: [] as string[],
}));

vi.mock('@/api/appAuth', () => ({
    appAuthActive: true,
    isRelayUrl: () => true,
    withAppAuth: (_url: string, init: RequestInit) => ({ ...init, headers: { Authorization: 'Bearer access-1' } }),
    appAccessToken: async () => 'access-1',
    cachedAppToken: () => 'access-1',
    appLogout: auth.appLogout,
    appForget: auth.appForget,
    appSocketUrl: auth.appSocketUrl,
}));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    auth.order = [];
    auth.appLogout.mockReset().mockImplementation(async () => auth.order.push('appLogout'));
    auth.appForget.mockReset().mockImplementation(async () => auth.order.push('appForget'));
    auth.appSocketUrl.mockReset().mockImplementation(async (url: string) => `${url}?rw_ticket=t1`);
    fetchMock = vi.fn(async (url: string, init: RequestInit) => {
        auth.order.push(`${init.method ?? 'GET'} ${url}`);
        return Response.json({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('アカウント', () => {
    it('ログアウトは、先にアプリのトークンを消してから Cookie のログアウトも呼ぶ', async () => {
        const { logout } = await import('@/features/cloud/account');
        await logout();
        expect(auth.order).toEqual(['appLogout', 'POST /auth/logout']);
    });

    it('すべての端末からログアウト・退会のあとは、アプリの中のトークンも消す', async () => {
        const { deleteAccount, logoutEverywhere } = await import('@/features/cloud/account');
        await logoutEverywhere();
        expect(auth.order).toEqual(['DELETE /me/sessions', 'appForget']);
        auth.order = [];
        await deleteAccount();
        expect(auth.order).toEqual(['DELETE /me', 'appForget']);
    });

    it('中間サーバーが断ったら、アプリの中のトークンは消さない', async () => {
        fetchMock.mockResolvedValue(Response.json({ detail: 'x' }, { status: 500 }));
        const { logoutEverywhere } = await import('@/features/cloud/account');
        await expect(logoutEverywhere()).rejects.toThrow();
        expect(auth.appForget).not.toHaveBeenCalled();
    });

    it('API には Authorization を付ける', async () => {
        const { fetchMe } = await import('@/features/cloud/account');
        await fetchMe();
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-1');
    });
});

describe('アップロード', () => {
    it('XMLHttpRequest に Authorization を付ける', async () => {
        const headers: Record<string, string> = {};
        class FakeXhr {
            upload = {};
            status = 202;
            responseText = JSON.stringify({ id: 's1' });
            onload: (() => void) | null = null;
            open() {}
            setRequestHeader(name: string, value: string) {
                headers[name] = value;
            }
            send() {
                queueMicrotask(() => this.onload?.());
            }
        }
        vi.stubGlobal('XMLHttpRequest', FakeXhr);
        const { uploadAudio } = await import('@/features/recording/upload');
        const file = new File(['x'], 'a.m4a', { lastModified: 1 });
        await uploadAudio('p', file, () => {});
        expect(headers.Authorization).toBe('Bearer access-1');
        expect(headers['Content-Type']).toBe('application/octet-stream');
    });
});

describe('WebSocket', () => {
    it('チケットを付けた URL でつなぐ', async () => {
        const urls: string[] = [];
        class FakeSocket {
            static OPEN = 1;
            readyState = 0;
            binaryType = '';
            onopen: (() => void) | null = null;
            onclose: (() => void) | null = null;
            onerror: (() => void) | null = null;
            onmessage: (() => void) | null = null;
            constructor(url: string) {
                urls.push(url);
                queueMicrotask(() => {
                    this.readyState = 1;
                    this.onopen?.();
                });
            }
            close() {}
        }
        vi.stubGlobal('WebSocket', FakeSocket);
        const { connection } = await import('@/api/connection');
        await connection.open();
        expect(auth.appSocketUrl).toHaveBeenCalledTimes(1);
        expect(urls).toHaveLength(1);
        expect(urls[0]).toMatch(/\/ws\?rw_ticket=t1$/);
    });
});
