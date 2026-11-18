import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { demoDataPlugin } from './vite/demoDataPlugin.ts';

// 画面のテスト（#169）。vite.config.ts の PWA などは読み込まず、パスの別名だけを合わせる。
// デモ版（#413）のデータは同梱せず、ふだんの画面（?demo のときだけデモ）として動かす
export default defineConfig({
    plugins: [demoDataPlugin(null)],
    define: {
        __APP_VERSION__: JSON.stringify('test'),
        __DEMO_BUILD__: 'false',
    },
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    test: {
        // data.ts などが location・document を使うので、ブラウザの代わりに jsdom で動かす
        environment: 'jsdom',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'vite/**/*.test.ts'],
    },
});
