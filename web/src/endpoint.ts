// API・WebSocket の URL を組み立てる、唯一の場所（#156。docs/spec/cloud.md 10.2・10.4 節）。
// ダイレクト版は /api/...・/ws、クラウド版は /h/<hostId>/api/...・/h/<hostId>/ws。通信の中身は変えない。
// 画面のほかの場所では、/api や /ws の URL を自分で組み立てずに、ここを通す

export type Mode = 'cloud' | 'direct';

// クラウド用のドメイン（ビルド時に VITE_CLOUD_HOSTS でカンマ区切りで渡す）。何も渡さなければ staging の分だけ
export const DEFAULT_CLOUD_HOSTS = 'rw-dev.studio-takumi.dev';

export function parseCloudHosts(value: string | undefined): string[] {
    return (value || DEFAULT_CLOUD_HOSTS)
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h !== '');
}

export function detectMode(hostname: string, cloudHosts: string[]): Mode {
    return cloudHosts.includes(hostname.toLowerCase()) ? 'cloud' : 'direct';
}

export const mode: Mode = detectMode(location.hostname, parseCloudHosts(import.meta.env.VITE_CLOUD_HOSTS));
export const isCloud = mode === 'cloud';

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
export function apiUrl(path: string, m: Mode = mode, hostId: string | null = currentHostId) {
    return hostPrefix(m, hostId) + path;
}

// WebSocket の URL。protocol は location.protocol（http: / https:）
export function wsUrl(
    where: { protocol: string; host: string } = location,
    m: Mode = mode,
    hostId: string | null = currentHostId,
) {
    const protocol = where.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${where.host}${hostPrefix(m, hostId)}/ws`;
}

// --- ホストに属さないパス（クラウド版の Worker が答える。ダイレクト版では使わない） ---

export const authLoginUrl = (provider: string) => `/auth/login/${encodeURIComponent(provider)}`;
export const authLogoutUrl = () => '/auth/logout';
export const meUrl = (path = '') => `/me${path}`;
// ホストの登録（#157）。確認の画面の API
export const pairUrl = (path: string) => `/pair/${path}`;
export const healthzUrl = () => '/healthz';
