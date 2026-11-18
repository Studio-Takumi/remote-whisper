// API・WebSocket の URL を組み立てる唯一の場所（#156。spec/cloud.md 10.2・10.4）。
// ほかの場所では /api や /ws を自分で組み立てず、ここを通す
import { isDemoBuild } from '@/api/demoBuild';

export type Mode = 'cloud' | 'direct';

// デモ版のビルド（#413）はサーバーにつながない。API・WebSocket の URL を作ろうとしたら例外にする
// （main を取り込んで、isDemo を見ずにサーバーへ投げる箇所が増えたときに気づけるように）
function refuseInDemo(target: string) {
    if (isDemoBuild) {
        const error = new Error(`デモ版はサーバーにつながりません: ${target}`);
        console.error(error);
        throw error;
    }
}

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
    refuseInDemo(path);
    return hostPrefix(m, hostId) + path;
}

// WebSocket の URL。protocol は location.protocol（http: / https:）
export function wsUrl(
    where: { protocol: string; host: string } = location,
    m: Mode = mode,
    hostId: string | null = currentHostId,
) {
    refuseInDemo('/ws');
    const protocol = where.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${where.host}${hostPrefix(m, hostId)}/ws`;
}

// --- ホストに属さないパス（クラウド版の Worker が答える。セルフホスト版では使わない） ---

export const authLoginUrl = (provider: string) => `/auth/login/${encodeURIComponent(provider)}`;
export const authLogoutUrl = () => '/auth/logout';
export const meUrl = (path = '') => `/me${path}`;
// ホストの登録（#157）。確認の画面の API
export const pairUrl = (path: string) => `/pair/${path}`;
export const healthzUrl = () => '/healthz';
