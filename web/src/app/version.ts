// 画面のバージョン（ビルドしたときのコミットハッシュ）。vite.config.ts の define で埋め込む
declare const __APP_VERSION__: string;

export const webVersion = __APP_VERSION__;

// デモ版（#414）でバージョンの代わりに出すもの。デモ版のもとにしたリリース
export const DEMO_BASE_VERSION = '1.0.0';
export const demoVersionLabel = `Ver${DEMO_BASE_VERSION} をもとにしたデモ版`;

// サーバーのバージョンを取る（GET /api/version）
export type VersionJson = { version: string };
