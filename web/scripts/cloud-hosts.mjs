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
            await page.getByRole('button', { name: 'ホストを切り替える' }).click();
            await step(page.locator('[data-hosts=choose]').waitFor(), '切り替えで選ぶ画面に戻る');
        },
    },
    {
        name: '前に選んだホストがあれば、それにつなぐ',
        hosts: [host(A, '書斎の PC', true), host(B, 'ノート PC', true)],
        remembered: B,
        check: (page) => page.getByText('ノート PC につないでいます').waitFor(),
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
    await page.route('**/me/hosts', (route) => route.fulfill({ json: { hosts: c.hosts } }));
    await page.route('**/h/**', (route) => route.fulfill({ status: 503, json: { detail: 'offline' } }));
    try {
        await page.goto(`http://localhost:${port}/`);
        await c.check(page);
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
