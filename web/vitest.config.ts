import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 画面のテスト（#169）。vite.config.ts の PWA などは読み込まず、パスの別名だけを合わせる
export default defineConfig({
    define: {
        __APP_VERSION__: JSON.stringify('test'),
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    test: {
        // data.ts などが location・document を使うので、ブラウザの代わりに jsdom で動かす
        environment: 'jsdom',
        include: ['src/**/*.test.ts'],
    },
});
