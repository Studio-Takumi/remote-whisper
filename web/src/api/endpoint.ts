// API・WebSocket の URL を組み立てる唯一の場所（#156。spec/cloud.md 10.2・10.4）。
// ほかの場所では /api や /ws を自分で組み立てず、ここを通す。
// ブラウザ版（iOS アプリの server.url も）は、画面と同じオリジンの相対 URL。画面をアプリに同梱したとき
// （#440。spec/mobile.md 11.8）だけ、保存した接続先（appEndpoint.ts）の絶対 URL にする
import { type AppEndpoint, loadAppEndpoint } from '@/features/native/appEndpoint';
import { isNativeApp } from '@/features/native/nativePlatform';

export type Mode = 'cloud' | 'direct';

// クラウド用のドメイン（ビルド時に VITE_CLOUD_HOSTS でカンマ区切りで渡す）。何も渡さなければ staging と本番（#167）
export const DEFAULT_CLOUD_HOSTS = 'rw-dev.studio-takumi.dev,rw.studio-takumi.dev';

export function parseCloudHosts(value: string | undefined): string[] {
    return (value || DEFAULT_CLOUD_HOSTS)
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== '');
}

export function detectMode(hostname: string, cloudHosts: string[]): Mode {
    return cloudHosts.includes(hostname.toLowerCase()) ? 'cloud' : 'direct';
}

// 接続先。base は URL の前に付けるオリジン（https://pc.example:8443）で、'' は画面と同じオリジン（相対 URL）。
// unset は、同梱した画面で接続先がまだ決まっていないとき（App が接続先の画面を出す）
export type Endpoint = { base: string; mode: Mode; unset: boolean };

// 画面をアプリに同梱しているか。アプリの中で、画面が http(s) で開かれていない（capacitor://localhost）とき。
// server.url で開いたときは http(s) なので、ブラウザ版と同じに扱う
export function isBundled(where: { protocol: string }, native: boolean): boolean {
    return native && where.protocol !== 'http:' && where.protocol !== 'https:';
}

// 同梱していなければ、画面のホスト名でモードを決める（今まで通り）。同梱していれば、保存した接続先の
// URL とモードを使う（モードはホスト名からでなく、保存した値で渡す）
export function resolveEndpoint(
    hostname: string,
    cloudHosts: string[],
    bundled: { saved: AppEndpoint | null } | null,
): Endpoint {
    if (!bundled) {
        return { base: '', mode: detectMode(hostname, cloudHosts), unset: false };
    }
    if (!bundled.saved) {
        return { base: '', mode: 'direct', unset: true };
    }
    return { base: bundled.saved.url, mode: bundled.saved.mode, unset: false };
}

const cloudHosts = parseCloudHosts(import.meta.env.VITE_CLOUD_HOSTS);
// 保存した接続先は、同梱しているときだけ読む
export const bundled = isBundled(location, isNativeApp());
export const endpoint = resolveEndpoint(location.hostname, cloudHosts, bundled ? { saved: loadAppEndpoint() } : null);
export const mode: Mode = endpoint.mode;
export const isCloud = mode === 'cloud';

// 接続先の画面で、入力した URL（normalizeEndpointUrl をとおしたもの）からモードを決める
export const modeOfUrl = (url: string): Mode => detectMode(new URL(url).hostname, cloudHosts);

// 今つないでいるホスト（クラウド版のみ）。setHostId は cloud.ts の dispatch からだけ呼ぶ（ほかから直接呼ばない）
let currentHostId: string | null = null;

export function setHostId(hostId: string | null) {
    currentHostId = hostId;
}

// 録音ごとの数字（#206）を送るときの、今つないでいるホスト
export function getHostId() {
    return currentHostId;
}

function hostPrefix(m: Mode, hostId: string | null) {
    if (m === 'direct') {
        return '';
    }
    if (!hostId) {
        throw new Error('ホストが選ばれていません');
    }
    return `/h/${encodeURIComponent(hostId)}`;
}

// path は /api/... の形。ホストに届く API の URL にする
export function apiUrl(path: string, m: Mode = mode, hostId: string | null = currentHostId, base = endpoint.base) {
    return base + hostPrefix(m, hostId) + path;
}

// WebSocket の URL を組み立てる元。接続先の URL があればそれ、なければ画面の location
export function wsOrigin(base = endpoint.base): { protocol: string; host: string } {
    return base ? new URL(base) : location;
}

// WebSocket の URL。protocol は http: / https:
export function wsUrl(
    where: { protocol: string; host: string } = wsOrigin(),
    m: Mode = mode,
    hostId: string | null = currentHostId,
) {
    const protocol = where.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${where.host}${hostPrefix(m, hostId)}/ws`;
}

// --- ホストに属さないパス（クラウド版の Worker が答える。セルフホスト版では使わない） ---

// path は /me などの形
export const workerUrl = (path: string, base = endpoint.base) => base + path;

export const authLoginUrl = (provider: string) => workerUrl(`/auth/login/${encodeURIComponent(provider)}`);
export const authLogoutUrl = () => workerUrl('/auth/logout');
export const meUrl = (path = '') => workerUrl(`/me${path}`);
// ホストの登録（#157）。確認の画面の API
export const pairUrl = (path: string) => workerUrl(`/pair/${path}`);
export const healthzUrl = () => workerUrl('/healthz');
