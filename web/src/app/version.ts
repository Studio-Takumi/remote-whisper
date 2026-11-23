// 画面のバージョン（ビルドしたときの git のタグとハッシュ。spec/api.md 7.1）。vite.config.ts の define で埋め込む
declare const __APP_VERSION__: string;

export const webVersion = __APP_VERSION__;

// ホストの新しい版（#472）。url はリリースノート
export type ReleaseJson = { version: string; url: string };

// サーバーのバージョンを取る（GET /api/version）。latest・updateAvailable は古いサーバーにはない
export type VersionJson = { version: string; latest?: ReleaseJson | null; updateAvailable?: boolean };

// 知らせる新しい版。x.y が上がったとき（updateAvailable）だけで、リリースノートが https のものに限る
export function hostUpdateOf(json: VersionJson): ReleaseJson | null {
    const latest = json.latest;
    if (!json.updateAvailable || !latest || typeof latest.version !== 'string' || typeof latest.url !== 'string') {
        return null;
    }
    return latest.url.startsWith('https://') ? { version: latest.version, url: latest.url } : null;
}

// 画面に出す版の名前（v1.1.0 → v1.1）。z は知らせの対象ではないので出さない
export function minorVersion(version: string): string {
    return /^v\d+\.\d+/.exec(version)?.[0] ?? version;
}
