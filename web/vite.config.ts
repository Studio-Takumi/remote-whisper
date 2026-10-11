import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 開発中は /api と /ws をサーバーへ転送する。本番はサーバーが web/dist を配信するので同じオリジンになる
const server = process.env.REMOTE_WHISPER_SERVER ?? 'http://localhost:8000';

// 画面のバージョン。サーバーと同じく git のコミットハッシュで、コミットしていない変更があれば +dirty（spec 7.1）
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
    plugins: [react(), tailwindcss()],
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
