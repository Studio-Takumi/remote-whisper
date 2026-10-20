// クラウド版のホストの選択（#161）を、偽の Worker で確かめる（0 台・1 台・2 台以上・オフライン・前に選んだもの）
//
// 動かし方: cd web && npm run check:cloud-hosts
// - vite の開発サーバーを localhost をクラウド用のドメインとして立て（VITE_CLOUD_HOSTS=localhost）、
//   /me・/me/hosts は Playwright で偽の返事にする。ホストへの API（/h/...）は 503 にする
// - CHROMIUM_PATH で使う Chromium を変えられる（省略すると Playwright のもの）
import { chromium } from 'playwright';
import { createServer } from 'vite';

process.env.VITE_CLOUD_HOSTS = 'localhost';
const port = 5199;
const server = await createServer({ server: { port, strictPort: true }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });

// どの手順で止まったかをエラーに付ける
async function step(promise, name) {
    try {
        await promise;
    } catch (e) {
        throw new Error(`${name}: ${e.message.split('\n')[0]}`);
    }
}

const me = {
    id: 'u1',
    displayName: 'テスト',
    tosVersion: '2026-10-20',
    identities: [{ id: 'i1', provider: 'github', email: null, displayName: 'テスト', createdAt: 0 }],
    providers: ['google', 'discord', 'github'],
};
const host = (id, name, online) => ({ id, name, appVersion: null, createdAt: 0, lastSeenAt: null, online });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

const cases = [
    {
        name: '0 台なら登録の案内',
        hosts: [],
        check: (page) => page.locator('[data-hosts=none]').waitFor(),
    },
    {
        name: '1 台ならそのままつなぎ、上部に出す',
        hosts: [host(A, '書斎の PC', true)],
        check: (page) => page.getByText('書斎の PC につないでいます').waitFor(),
    },
    {
        name: '2 台以上なら選ぶ画面。オフラインのものは押せない',
        hosts: [host(A, '書斎の PC', true), host(B, 'ノート PC', false)],
        check: async (page) => {
            await page.locator('[data-hosts=choose]').waitFor();
            if (!(await page.getByRole('button', { name: /ノート PC/ }).isDisabled())) {
                throw new Error('オフラインのホストが押せる');
            }
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await step(page.getByText('書斎の PC につないでいます').waitFor(), '選んだホストにつなぐ');
            // 選び直せる
            await page.getByRole('button', { name: '書斎の PC につないでいます' }).click();
            await step(page.locator('[data-hosts=choose]').waitFor(), '切り替えで選ぶ画面に戻る');
        },
    },
    {
        name: '別のホストに切り替えたら、読み込み直してそのホストにつなぐ（#222）',
        hosts: [host(A, '書斎の PC', true), host(B, 'ノート PC', true)],
        check: async (page) => {
            let loads = 0;
            page.on('load', () => loads++);
            await page.locator('[data-hosts=choose]').waitFor();
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await step(page.getByText('書斎の PC につないでいます').waitFor(), 'A につなぐ');
            await page.getByRole('button', { name: '書斎の PC につないでいます' }).click();
            await page.getByRole('button', { name: /ノート PC/ }).click();
            await step(page.getByText('ノート PC につないでいます').waitFor(), '読み込み直して B につなぐ');
            if (loads < 1) {
                throw new Error('読み込み直していない');
            }
        },
    },
    {
        name: '同じホストを選び直したら、読み込み直さない',
        hosts: [host(A, '書斎の PC', true), host(B, 'ノート PC', true)],
        check: async (page) => {
            let loads = 0;
            page.on('load', () => loads++);
            await page.locator('[data-hosts=choose]').waitFor();
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await page.getByText('書斎の PC につないでいます').waitFor();
            await page.getByRole('button', { name: '書斎の PC につないでいます' }).click();
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await page.getByText('書斎の PC につないでいます').waitFor();
            if (loads > 0) {
                throw new Error('読み込み直した');
            }
        },
    },
    {
        name: '前に選んだホストがあれば、それにつなぐ',
        hosts: [host(A, '書斎の PC', true), host(B, 'ノート PC', true)],
        remembered: B,
        check: (page) => page.getByText('ノート PC につないでいます').waitFor(),
    },
    {
        name: '一覧の読み込みに失敗しても、もう一度で先に進む',
        hosts: [host(A, '書斎の PC', true)],
        failFirst: true,
        check: async (page, self) => {
            await step(page.locator('[data-hosts=error]').waitFor(), '失敗を出す');
            self.retried = true;
            await page.getByRole('button', { name: 'もう一度' }).click();
            await step(page.getByText('書斎の PC につないでいます').waitFor(), 'もう一度でつなぐ');
        },
    },
    {
        name: '1 台でオフラインなら、選ぶ画面で知らせる',
        hosts: [host(A, '書斎の PC', false)],
        check: (page) => page.getByText('どの PC もオフラインです').waitFor(),
    },
];

let failed = 0;
for (const c of cases) {
    const context = await browser.newContext();
    if (c.remembered) {
        await context.addInitScript((id) => localStorage.setItem('rw.cloud.lastHostId', id), c.remembered);
    }
    const page = await context.newPage();
    await page.route('**/me', (route) => route.fulfill({ json: me }));
    // failFirst: 「もう一度」を押すまでは失敗させる（開発モードでは effect が 2 回走るので、回数では決めない）
    await page.route('**/me/hosts', (route) =>
        c.failFirst && !c.retried
            ? route.fulfill({ status: 500, json: { detail: 'boom' } })
            : route.fulfill({ json: { hosts: c.hosts } }),
    );
    await page.route('**/h/**', (route) => route.fulfill({ status: 503, json: { detail: 'offline' } }));
    try {
        await page.goto(`http://localhost:${port}/`);
        await c.check(page, c);
        console.log(`ok   ${c.name}`);
    } catch (e) {
        failed++;
        console.log(`FAIL ${c.name}: ${e.message.split('\n')[0]}`);
    }
    await context.close();
}

await browser.close();
await server.close();
process.exit(failed ? 1 : 0);
