// iOS アプリの中のクラウド版のログイン（#441。spec/mobile.md 11.10）。トークン・チケットを付けるのはアプリの中のクラウド版だけで、
// ブラウザ版・セルフホスト版では何もしない（init もそのまま返す・ネイティブのコードも読み込まない）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const bridge = vi.hoisted(() => ({
    loaded: 0,
    token: 'access-1' as string | null,
    appAuthToken: vi.fn(),
    appAuthLogin: vi.fn(),
    appAuthLogout: vi.fn(),
    appAuthForget: vi.fn(),
}));

vi.mock('@/features/native/nativeBridge', () => {
    bridge.loaded++;
    return {
        appAuthToken: bridge.appAuthToken,
        appAuthLogin: bridge.appAuthLogin,
        appAuthLogout: bridge.appAuthLogout,
        appAuthForget: bridge.appAuthForget,
    };
});

const where = vi.hoisted(() => ({ cloud: true, hostId: '11111111-2222-4333-8444-555555555555' as string | null }));

vi.mock('@/api/endpoint', () => ({
    get isCloud() {
        return where.cloud;
    },
    endpoint: { base: '', mode: 'cloud', unset: false },
    getHostId: () => where.hostId,
    meUrl: (path = '') => `/me${path}`,
}));

const HOST = '11111111-2222-4333-8444-555555555555';
const RECORDING = `/h/${HOST}/api/projects/p-1/sessions/20261009-143012/recording`;

function setNative(native: boolean) {
    const w = window as { Capacitor?: unknown };
    if (native) {
        w.Capacitor = { isNativePlatform: () => true };
    } else {
        delete w.Capacitor;
    }
}

async function load(opts: { native: boolean; cloud?: boolean }) {
    setNative(opts.native);
    where.cloud = opts.cloud ?? true;
    vi.resetModules();
    return import('@/api/appAuth');
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    bridge.loaded = 0;
    bridge.token = 'access-1';
    bridge.appAuthToken.mockReset().mockImplementation(async () => bridge.token);
    bridge.appAuthLogin.mockReset().mockResolvedValue(undefined);
    bridge.appAuthLogout.mockReset().mockResolvedValue(undefined);
    bridge.appAuthForget.mockReset().mockResolvedValue(undefined);
    where.hostId = HOST;
    let n = 0;
    fetchMock = vi.fn(async () => Response.json({ ticket: `t${++n}`, expiresAt: Date.now() + 3_600_000 }));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
    setNative(false);
    vi.unstubAllGlobals();
});

describe('ブラウザ版・セルフホスト版', () => {
    it('init をそのまま返し、ネイティブのコードを読み込まない', async () => {
        for (const opts of [{ native: false }, { native: true, cloud: false }, { native: false, cloud: false }]) {
            const m = await load(opts);
            expect(m.appAuthActive).toBe(false);
            const init = { method: 'POST' };
            expect(m.withAppAuth(init)).toBe(init);
            expect(await m.appAccessToken()).toBeNull();
            expect(await m.appSocketUrl('wss://x/h/1/ws')).toBe('wss://x/h/1/ws');
            expect(await m.appMediaUrl(RECORDING)).toBe(RECORDING);
            await m.appLogout();
            await m.appForget();
        }
        expect(bridge.loaded).toBe(0);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('アプリの中のクラウド版', () => {
    it('API に Authorization: Bearer を付ける（ほかのヘッダーは残す）', async () => {
        const m = await load({ native: true });
        expect(m.appAuthActive).toBe(true);
        const init = await m.withAppAuth({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
        const headers = new Headers(init.headers);
        expect(headers.get('Authorization')).toBe('Bearer access-1');
        expect(headers.get('Content-Type')).toBe('application/json');
        expect(bridge.appAuthToken).toHaveBeenCalledWith(location.origin);
    });

    it('トークンがなければ何も付けない（server.url の WebView の Cookie のまま）', async () => {
        bridge.token = null;
        const m = await load({ native: true });
        const init = { method: 'GET' };
        expect(await m.withAppAuth(init)).toBe(init);
        expect(await m.appSocketUrl('wss://x/ws')).toBe('wss://x/ws');
        expect(await m.appMediaUrl(RECORDING)).toBe(RECORDING);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('WebSocket には、つなぐたびに一度だけのチケットを付ける', async () => {
        const m = await load({ native: true });
        expect(await m.appSocketUrl(`wss://rw.example/h/${HOST}/ws`)).toBe(
            `wss://rw.example/h/${HOST}/ws?rw_ticket=t1`,
        );
        expect(await m.appSocketUrl(`wss://rw.example/h/${HOST}/ws`)).toBe(
            `wss://rw.example/h/${HOST}/ws?rw_ticket=t2`,
        );
        const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('/me/tickets');
        expect(new Headers(init.headers).get('Authorization')).toBe('Bearer access-1');
        expect(JSON.parse(String(init.body))).toEqual({ hostId: HOST, kind: 'ws', path: '/ws' });
    });

    it('音声には、そのパスのチケットを付け、期限の近くまで使い回す', async () => {
        const m = await load({ native: true });
        expect(await m.appMediaUrl(`${RECORDING}?source=2`)).toBe(`${RECORDING}?source=2&rw_ticket=t1`);
        expect(await m.appMediaUrl(RECORDING)).toBe(`${RECORDING}?rw_ticket=t1`);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({
            hostId: HOST,
            kind: 'media',
            path: '/api/projects/p-1/sessions/20261009-143012/recording',
        });
        // 残りが 10 分を切ったら作り直す
        expect(await m.appMediaUrl(RECORDING, Date.now() + 55 * 60 * 1000)).toBe(`${RECORDING}?rw_ticket=t2`);
        // ログアウトしたら使い回さない
        await m.appLogout();
        expect(await m.appMediaUrl(RECORDING)).toBe(`${RECORDING}?rw_ticket=t3`);
    });

    it('チケットを作れなければ元の URL のまま', async () => {
        fetchMock.mockResolvedValue(new Response('{}', { status: 403 }));
        const m = await load({ native: true });
        expect(await m.appSocketUrl('wss://x/ws')).toBe('wss://x/ws');
        expect(await m.appMediaUrl(RECORDING)).toBe(RECORDING);
    });

    it('ログイン・ログアウトは中間サーバーのオリジンを渡す', async () => {
        const m = await load({ native: true });
        await m.appLogin('google');
        expect(bridge.appAuthLogin).toHaveBeenCalledWith(location.origin, 'google');
        await m.appLogout();
        expect(bridge.appAuthLogout).toHaveBeenCalledWith(location.origin);
        await m.appForget();
        expect(bridge.appAuthForget).toHaveBeenCalledWith(location.origin);
        expect(m.isCanceled(Object.assign(new Error('canceled'), { code: 'canceled' }))).toBe(true);
        expect(m.isCanceled(new Error('x'))).toBe(false);
    });
});

describe('道具', () => {
    it('中間サーバーのオリジン・音声のパス', async () => {
        const m = await load({ native: false });
        expect(m.relayOrigin('https://rw.example', { origin: 'capacitor://localhost' })).toBe('https://rw.example');
        expect(m.relayOrigin('', { origin: 'https://rw.example' })).toBe('https://rw.example');
        expect(m.mediaTarget(`https://rw.example${RECORDING}?source=2`)).toEqual({
            hostId: HOST,
            path: '/api/projects/p-1/sessions/20261009-143012/recording',
        });
        expect(m.mediaTarget(`/h/${HOST}/api/projects`)).toBeNull();
        expect(m.mediaTarget('/api/projects/p/sessions/s/recording')).toBeNull();
        expect(m.withTicket('/a?b=1', 'x y')).toBe('/a?b=1&rw_ticket=x%20y');
    });
});
