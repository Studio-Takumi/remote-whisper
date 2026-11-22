// 画面を iOS アプリに同梱したとき（#440。spec/mobile.md 11.9）の接続先（ホストかクラウド版の URL）。
// 同梱した画面のオリジン（capacitor://localhost）はホストと違うので、API・WebSocket はここに保存した URL へ送る。
// ブラウザ版とアプリの server.url では使わない（endpoint.ts が、同梱したときだけ読む）
import type { Mode } from '@/api/endpoint';

export type AppEndpoint = { url: string; mode: Mode };

const KEY = 'remote-whisper.appEndpoint';

type Read = Pick<Storage, 'getItem'>;
type Write = Pick<Storage, 'setItem' | 'removeItem'>;

function safeStorage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}

// 入力された URL を、パスのないオリジン（https://pc.example:8443）にそろえる。scheme を書かなければ https。
// http(s) 以外・ユーザー名やパスワード・パス・? # があれば null
export function normalizeEndpointUrl(input: string): string | null {
    const text = input.trim();
    if (text === '') {
        return null;
    }
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
        return null;
    }
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
        return null;
    }
    return url.origin;
}

export function loadAppEndpoint(storage: Read | null = safeStorage()): AppEndpoint | null {
    try {
        const raw = storage?.getItem(KEY);
        if (!raw) {
            return null;
        }
        const value = JSON.parse(raw) as Partial<AppEndpoint> | null;
        const url = typeof value?.url === 'string' ? normalizeEndpointUrl(value.url) : null;
        if (!url || (value?.mode !== 'cloud' && value?.mode !== 'direct')) {
            return null;
        }
        return { url, mode: value.mode };
    } catch {
        return null;
    }
}

export function saveAppEndpoint(endpoint: AppEndpoint | null, storage: Write | null = safeStorage()): boolean {
    try {
        if (endpoint) {
            storage?.setItem(KEY, JSON.stringify(endpoint));
        } else {
            storage?.removeItem(KEY);
        }
        return storage !== null;
    } catch {
        return false;
    }
}
