import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// 開発中は /api と /ws をサーバーへ転送する。本番はサーバーが web/dist を配信するので同じオリジンになる
const server = process.env.REMOTE_WHISPER_SERVER ?? 'http://localhost:8000';

// https://vite.dev/config/
export default defineConfig({
    plugins: [react(), tailwindcss()],
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
