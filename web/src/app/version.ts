// 画面のバージョン（ビルドしたときのコミットハッシュ）。vite.config.ts の define で埋め込む
declare const __APP_VERSION__: string;

export const webVersion = __APP_VERSION__;

// サーバーのバージョンを取る（GET /api/version）
export type VersionJson = { version: string };
