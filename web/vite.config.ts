import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// 開発中は /api と /ws をサーバーへ転送する。本番はサーバーが web/dist を配信するので同じオリジンになる
const server = process.env.REMOTE_WHISPER_SERVER ?? 'http://localhost:8000';

// 画面のバージョン。サーバーと同じく git のコミットハッシュで、コミットしていない変更があれば +dirty（spec/api.md 7.1）
function appVersion() {
    const git = (...args: string[]) => execFileSync('git', args, { encoding: 'utf8', timeout: 5000 }).trim();
    try {
        const commit = git('rev-parse', '--short', 'HEAD');
        const dirty = git('status', '--porcelain', '--untracked-files=no');
        return commit ? (dirty ? `${commit}+dirty` : commit) : 'unknown';
    } catch {
        return 'unknown';
    }
}

// https://vite.dev/config/
export default defineConfig({
    plugins: [
        react(),
        tailwindcss(),
        // PWA（#104）。ホーム画面から単独のアプリとして開けるようにする。
        // キャッシュするのは画面（HTML・JS・CSS・アイコン）だけで、API と WebSocket はキャッシュしない
        VitePWA({
            // 新しい版が入ったら、画面で知らせてから読み込み直す（PwaUpdater）
            registerType: 'prompt',
            injectRegister: false,
            manifest: {
                name: 'Remote Whisper',
                short_name: 'Whisper',
                description: '別のマシンの GPU で、疑似リアルタイムに文字起こしと要約をする',
                lang: 'ja',
                start_url: '/',
                scope: '/',
                display: 'standalone',
                background_color: '#171717',
                theme_color: '#171717',
                icons: [
                    { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
                    { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
                    { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
                ],
            },
            workbox: {
                // 入れたときに取っておくのは、画面の骨組み（HTML・最初の JS と CSS・アイコン・録音の worklet）だけ。
                // コードの色付けの言語などの残り（約 300 ファイル・13MB）は、使ったときに取って置いておく
                globPatterns: ['index.html', 'assets/index-*.{js,css}', '*.{svg,png,js}'],
                maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
                navigateFallback: 'index.html',
                // 画面の読み込み直し（navigation）として扱わないパス。クラウド版のホスト経由（/h/）・ログイン（/auth/）・
                // アカウント（/me/）・ホストの登録（/pair）・死活（/healthz）は、Worker に直接取りに行く
                navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/h\//, /^\/auth\//, /^\/me\//, /^\/pair/, /^\/healthz/],
                cleanupOutdatedCaches: true,
                runtimeCaching: [
                    {
                        // ハッシュ付きの名前なので、中身は変わらない
                        urlPattern: ({ url }) => url.pathname.startsWith('/assets/'),
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'assets',
                            expiration: { maxEntries: 400, maxAgeSeconds: 30 * 24 * 60 * 60 },
                        },
                    },
                ],
            },
        }),
    ],
    define: {
        __APP_VERSION__: JSON.stringify(appVersion()),
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        proxy: {
            '/api': server,
            '/ws': { target: server, ws: true },
        },
    },
});
