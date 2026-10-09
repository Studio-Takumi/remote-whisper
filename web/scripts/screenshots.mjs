// 説明用のスクリーンショットを撮って docs/images/ に保存する
//
// 準備（別々のターミナルで）:
//   cd server && uv run remote-whisper --mock --mock-live-summary-sec 5
//   cd web && npm run dev
// 撮る:
//   cd web && npm run screenshots
//
// 環境変数:
//   SCREENSHOT_URL  画面の URL（既定: http://localhost:5173）
//   CHROMIUM_PATH   使う Chromium の実行ファイル（省略すると Playwright のもの。`npx playwright install chromium` で入る）
//
// 画面のデータは web/src/mock.ts のダミー（架空の打ち合わせと講義）と、モックサーバーが流すダミーの文字起こし・要約
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const url = process.env.SCREENSHOT_URL ?? 'http://localhost:5173';
const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // 偽のマイクで録音する（許可のダイアログも出さない）
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

const layouts = {
    desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    mobile: { viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// 撮る画面。open で画面を作り、shot で撮る
const scenes = [
    {
        name: 'transcript',
        async open(page, { mobile }) {
            await openSession(page, mobile, '新機能のリリース計画');
        },
    },
    {
        name: 'summary',
        async open(page, { mobile }) {
            await openSession(page, mobile, 'アルゴリズム 二分探索');
            await page.getByRole('tab', { name: '要約' }).click();
        },
    },
    {
        name: 'recording',
        // 録音中の文字起こし（文字送り・薄い未確定部分）と、途中の要約を続けて撮る
        async open(page, { mobile, shot }) {
            await openNewSession(page, mobile, 'meetings');
            await page.getByLabel('クリックして録音開始').click();
            // 途中の要約（モックサーバーは --mock-live-summary-sec の間隔で送る）が届くまで待つ
            await page.waitForFunction(() => window.appStore?.getState().projects[0].sessions[0].liveSummary, null, {
                timeout: 30000,
            });
            await waitForPartial(page);
            // 待つと区間が確定してしまうので、すぐ撮る
            await shot('recording', 0);
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('recording-summary');
            await page.getByLabel('クリックして録音終了').click();
            // stop が届く前に閉じると、モックサーバーがセッションを 60 秒持ち続けて次の録音を始められない
            await page.waitForTimeout(1500);
        },
        manual: true,
    },
    {
        name: 'quick-settings',
        async open(page, { mobile }) {
            await openSession(page, mobile, 'アルゴリズム 二分探索');
            if (mobile) {
                await page.getByLabel('簡易設定').click();
            } else {
                await page.getByText('要約(最終)').locator('..').getByRole('combobox').click();
            }
        },
    },
    {
        name: 'settings',
        async open(page, { mobile }) {
            if (mobile) {
                await page.getByLabel('メニューを開く').click();
            }
            await page.getByRole('button', { name: '設定', exact: true }).click();
            await page.getByRole('tab', { name: '要約' }).click();
        },
    },
    {
        name: 'materials',
        async open(page, { mobile }) {
            await openNewSession(page, mobile, 'meetings');
            await page.getByText('agenda.md, notes.md').click();
            await page.getByRole('button', { name: '資料を選んで新しく作る' }).click();
            await page.getByText('meetings', { exact: true }).last().click();
            await page.getByText('release-plan.md').click();
        },
    },
    {
        name: 'new-project',
        async open(page, { mobile }) {
            if (mobile) {
                await page.getByLabel('メニューを開く').click();
            }
            await page.getByRole('button', { name: '新規プロジェクト作成' }).click();
            await page.getByText('interviews', { exact: true }).click();
        },
    },
    {
        // デスクトップはサイドバーを閉じた状態、スマホはサイドバー（メニュー）を開いた状態
        name: 'sidebar',
        async open(page, { mobile }) {
            if (mobile) {
                await openSession(page, mobile, '新機能のリリース計画');
                await page.getByLabel('メニューを開く').click();
            } else {
                await openSession(page, mobile, '新機能のリリース計画');
                await page.keyboard.press('Control+b');
            }
        },
    },
];

async function openSession(page, mobile, title) {
    if (mobile) {
        await page.getByLabel('メニューを開く').click();
    }
    await page.getByText(title, { exact: true }).click();
}

async function openNewSession(page, mobile, project) {
    if (mobile) {
        await page.getByLabel('メニューを開く').click();
    }
    await page.getByLabel(`${project}で新しく録音`).click();
}

// 文字送りの途中（確定部分と未確定部分の両方がある）になるまで待つ
async function waitForPartial(page) {
    await page.waitForFunction(
        () => {
            const p = window.appStore?.getState().partial;
            return p && p.committed.length > 8 && p.tentative.length > 0;
        },
        null,
        { timeout: 30000 },
    );
}

for (const [layoutName, layout] of Object.entries(layouts)) {
    for (const colorScheme of ['light', 'dark']) {
        const context = await browser.newContext({ ...layout, colorScheme });
        for (const scene of scenes) {
            const page = await context.newPage();
            await page.goto(url);
            // 開発用パネルのボタンは写さない
            await page.addStyleTag({ content: '[aria-label="開発用パネル"] { display: none !important; }' });
            const shot = async (name, wait = 700) => {
                // ダイアログなどのアニメーションが終わるのを待つ
                await page.waitForTimeout(wait);
                const file = path.join(outDir, `${layoutName}-${colorScheme}-${name}.png`);
                await page.screenshot({ path: file });
                console.log(path.relative(process.cwd(), file));
            };
            await scene.open(page, { mobile: layoutName === 'mobile', shot });
            if (!scene.manual) {
                await shot(scene.name);
            }
            await page.close();
        }
        await context.close();
    }
}
await browser.close();
