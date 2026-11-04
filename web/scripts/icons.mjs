// アイコンの PNG を、元の SVG（web/public/app-icon.svg・badge.svg）から書き出す（#284）
//
//   cd web && npm run icons
//
// 環境変数:
//   CHROMIUM_PATH  使う Chromium の実行ファイル（省略すると Playwright のもの。`npx playwright install chromium` で入る）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');

// [元の SVG, 書き出す PNG, 大きさ(px), 背景を透明にするか]
const targets = [
    ['app-icon.svg', 'pwa-512.png', 512, false],
    ['app-icon.svg', 'pwa-192.png', 192, false],
    ['app-icon.svg', 'apple-touch-icon.png', 180, false],
    // 通知のバッジは、Android が形（不透明なところ）だけを使うので透明にする
    ['badge.svg', 'badge.png', 96, true],
];

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
try {
    for (const [src, out, size, transparent] of targets) {
        const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
        // 空のページ（about:blank）からは file:// の画像を読めないので、data URL にして埋め込む
        const svg = fs.readFileSync(path.join(publicDir, src));
        const url = `data:image/svg+xml;base64,${svg.toString('base64')}`;
        await page.setContent(
            `<style>html,body{margin:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style><img src="${url}">`,
        );
        await page.locator('img').evaluate((img) => img.decode());
        await page.screenshot({ path: path.join(publicDir, out), omitBackground: transparent });
        await page.close();
        console.log(`${src} -> ${out} (${size}px)`);
    }
} finally {
    await browser.close();
}
