// クラウド版の画面の CSP（web/public/_headers。#253）で、主な画面に違反が出ないかを Chromium と WebKit で確かめる
//
// 動かし方:
//   cd web && VITE_CLOUD_HOSTS=localhost npx vite build    （localhost をクラウド版として dist を作る）
//   cd web && npm run check:csp
//
// オプション:
//   --headers <file>   使う _headers（既定: dist/_headers）。強制にする前の版と比べるときに渡す
//   --browsers <a,b>   chromium・webkit（既定: 両方）
//   --only <a,b>       名前に a か b を含む場面だけ
// 環境変数:
//   CHROMIUM_PATH      使う Chromium の実行ファイル（省略すると Playwright のもの）
//
// しくみ:
// - モックのホスト（server の --mock）を、使い捨てのホームで起こす（終わったら止めて消す）
// - Worker の代わりの小さなサーバーを localhost に立てる（HTTPS と HTTP）。dist を _headers のヘッダー付きで配り、
//   /me・/me/hosts・/pair/request などは場面ごとの偽の返事にし、/h/<id>/api と /h/<id>/ws はモックのホストへ流し、
//   /csp-report は届いた報告を取っておく。Playwright の route は使わない（WebSocket の route はページの中で
//   WebSocket を差し替えるので、connect-src が本当に当たるかを確かめられない）
// - HTTPS は openssl で作った自己署名の証明書。wss: が connect-src 'self' に当たるかは、HTTPS の画面で見る。
//   PWA の更新は HTTP（localhost）で見る（自己署名の証明書では service worker を登録できないため）
// - 違反は 3 つの道で拾う: ページの securitypolicyviolation、/csp-report に届いた報告、コンソールの CSP の文
// - 最初に、わざと違反を起こして（インラインのスクリプト・ほかのオリジンの画像・iframe に入れる）、
//   拾えること・強制なら止まることを確かめる
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium, webkit } from 'playwright';

const { values: args } = parseArgs({
    options: {
        headers: { type: 'string' },
        browsers: { type: 'string', default: 'chromium,webkit' },
        only: { type: 'string' },
    },
});

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distDir = path.join(webDir, 'dist');
const serverDir = path.join(webDir, '..', 'server');
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    console.error('dist がありません。先に VITE_CLOUD_HOSTS=localhost npx vite build を動かしてください');
    process.exit(2);
}
const headersFile = path.resolve(args.headers ?? path.join(distDir, '_headers'));
const pageHeaders = parseHeaders(fs.readFileSync(headersFile, 'utf8'));
const csp = pageHeaders['content-security-policy'] ?? pageHeaders['content-security-policy-report-only'] ?? '';
const enforced = 'content-security-policy' in pageHeaders;
console.log(`_headers: ${headersFile}`);
console.log(`CSP: ${enforced ? '強制' : 'Report-Only'}${pageHeaders['reporting-endpoints'] ? '・report-to あり' : ''}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-csp-'));
const HTTPS_PORT = 5281;
const HTTP_PORT = 5282;
const SERVER_PORT = 8091;
const serverUrl = `http://127.0.0.1:${SERVER_PORT}`;

// --- _headers ---

// `/*` の段のヘッダーだけを読む（今の _headers はこの段だけ）
function parseHeaders(text) {
    const out = {};
    let inAll = false;
    for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '' || line.trim().startsWith('#')) {
            continue;
        }
        if (!/^\s/.test(line)) {
            inAll = line.trim() === '/*';
            continue;
        }
        const m = /^\s+([^:]+):\s*(.*)$/.exec(line);
        if (inAll && m) {
            out[m[1].trim().toLowerCase()] = m[2].trim();
        }
    }
    return out;
}

// --- モックのホスト ---

const home = path.join(tmp, 'home');
const projectDir = path.join(tmp, 'meetings');
fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(
    path.join(projectDir, 'release-plan.md'),
    '# リリース計画\n\n- ステージング環境での確認\n- 負荷試験\n',
);

const server = spawn('uv', ['run', 'remote-whisper', '--mock', '--no-tray', '--port', String(SERVER_PORT)], {
    cwd: serverDir,
    env: { ...process.env, REMOTE_WHISPER_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
    shell: process.platform === 'win32',
});
let serverLog = '';
server.stderr.on('data', (d) => (serverLog = (serverLog + d).slice(-4000)));

async function api(method, p, body) {
    const res = await fetch(`${serverUrl}${p}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        throw new Error(`${method} ${p}: ${res.status} ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
}

async function waitForServer() {
    for (let i = 0; i < 120; i++) {
        try {
            await api('GET', '/api/version');
            return;
        } catch {
            await new Promise((r) => setTimeout(r, 500));
        }
    }
    throw new Error(`モックのホストが起きません\n${serverLog}`);
}

// --- Worker の代わり ---

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const host = (id, name, online) => ({ id, name, appVersion: null, createdAt: 1760000000000, lastSeenAt: null, online });
const ME = {
    id: 'u1',
    displayName: '山田 花子',
    tosVersion: '2026-10-20',
    tosCurrent: '2026-10-20',
    termsUrl: 'https://example.com/terms',
    privacyUrl: 'https://example.com/privacy',
    dataCollection: false,
    identities: [
        {
            id: 'i1',
            provider: 'google',
            email: 'hanako@example.com',
            displayName: '山田 花子',
            createdAt: 1760000000000,
        },
    ],
    providers: ['google', 'discord', 'github'],
};

// 場面ごとに変える偽の返事
let state = {};
// 届いた CSP の報告
let reports = [];
// sw.js の版（PWA の更新を起こすときに上げる）
let swVersion = 0;

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.txt': 'text/plain; charset=utf-8',
};

// Worker が答える返事に付くヘッダー（relay/src/index.ts の withSecurityHeaders）
const WORKER_HEADERS = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
};

function sendJson(res, status, body) {
    res.writeHead(status, { ...WORKER_HEADERS, 'Content-Type': 'application/json' });
    res.end(body === undefined ? '' : JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
}

async function worker(req, res, url) {
    const p = url.pathname;
    if (p === '/csp-report') {
        const body = await readBody(req);
        let parsed = null;
        try {
            parsed = JSON.parse(body);
        } catch {
            // 形の違うものも数える
        }
        for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
            reports.push({ type: req.headers['content-type'] ?? '', report: r, scene: state.scene });
        }
        res.writeHead(204, WORKER_HEADERS);
        return res.end();
    }
    if (p === '/me') {
        return state.me ? sendJson(res, 200, state.me) : sendJson(res, 401, { detail: 'ログインしてください' });
    }
    if (p === '/me/hosts') {
        return sendJson(res, 200, { hosts: state.hosts ?? [] });
    }
    if (p === '/me/sessions' && req.method === 'DELETE') {
        state.me = null;
        return sendJson(res, 200, { ok: true });
    }
    if (p.startsWith('/me/')) {
        res.writeHead(204, WORKER_HEADERS);
        return res.end();
    }
    if (p === '/auth/logout') {
        state.me = null;
        return sendJson(res, 200, { ok: true });
    }
    if (p === '/pair/request') {
        return sendJson(res, 200, {
            code: 'K7QM-4PXD',
            hostName: '書斎の PC',
            status: 'pending',
            answeredByMe: null,
            expiresAt: Date.now() + 10 * 60 * 1000,
            countryMismatch: state.countryMismatch ?? false,
        });
    }
    if (p === '/healthz') {
        return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { detail: 'Not found' });
}

// /h/<id>/api/... をモックのホストの /api/... へ。Origin は渡さない（ホストは Host と違うオリジンを断る。#249）
function relay(req, res, rest) {
    const headers = { ...req.headers, host: `127.0.0.1:${SERVER_PORT}` };
    delete headers.origin;
    delete headers.cookie;
    const upstream = http.request({ host: '127.0.0.1', port: SERVER_PORT, method: req.method, path: rest, headers });
    upstream.on('response', (r) => {
        const out = { ...r.headers };
        delete out['content-security-policy'];
        // 中継した返事に付くもの（relay/src/relay.ts の safeResponseHeaders）
        out['x-content-type-options'] = 'nosniff';
        out['content-security-policy'] = "sandbox; default-src 'none'; frame-ancestors 'none'";
        out['x-frame-options'] = 'DENY';
        res.writeHead(r.statusCode ?? 502, out);
        r.pipe(res);
    });
    upstream.on('error', () => sendJson(res, 502, { detail: 'host' }));
    req.pipe(upstream);
}

function serveStatic(req, res, url) {
    let file = path.join(distDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(distDir)) {
        res.writeHead(400);
        return res.end();
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        // SPA（wrangler.jsonc の not_found_handling）
        file = path.join(distDir, 'index.html');
    }
    let body = fs.readFileSync(file);
    if (path.basename(file) === 'sw.js' && swVersion > 0) {
        body = Buffer.concat([body, Buffer.from(`\n// version ${swVersion}\n`)]);
    }
    res.writeHead(200, {
        ...Object.fromEntries(Object.entries(pageHeaders).map(([k, v]) => [k, v])),
        'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
    });
    res.end(body);
}

const WORKER_FIRST = [/^\/h\//, /^\/auth\//, /^\/me$/, /^\/me\//, /^\/pair\//, /^\/healthz$/, /^\/csp-report$/];

async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/h\/[0-9a-f-]{36}(\/api\/.*)$/.exec(url.pathname);
    if (m) {
        return relay(req, res, m[1] + url.search);
    }
    if (WORKER_FIRST.some((re) => re.test(url.pathname))) {
        return worker(req, res, url);
    }
    return serveStatic(req, res, url);
}

// /h/<id>/ws をモックのホストの /ws へ（101 を返したら、あとはそのままつなぐ）
function upgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (!/^\/h\/[0-9a-f-]{36}\/ws$/.test(url.pathname)) {
        socket.destroy();
        return;
    }
    upgrades.push({ scene: state.scene, url: req.url });
    const headers = { ...req.headers, host: `127.0.0.1:${SERVER_PORT}` };
    delete headers.origin;
    delete headers.cookie;
    const upstream = http.request({ host: '127.0.0.1', port: SERVER_PORT, path: '/ws', headers });
    upstream.on('upgrade', (r, up, upHead) => {
        const lines = [`HTTP/1.1 101 Switching Protocols`];
        for (const [k, v] of Object.entries(r.headers)) {
            lines.push(`${k}: ${v}`);
        }
        socket.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (upHead.length) {
            socket.write(upHead);
        }
        if (head.length) {
            up.write(head);
        }
        up.pipe(socket).pipe(up);
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
    });
    upstream.on('response', () => socket.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
}
let upgrades = [];

const certDir = path.join(tmp, 'cert');
fs.mkdirSync(certDir);
execFileSync(
    'openssl',
    [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        path.join(certDir, 'key.pem'),
        '-out',
        path.join(certDir, 'cert.pem'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
    ],
    { stdio: 'ignore' },
);
const httpsServer = https.createServer(
    { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) },
    (req, res) => void handle(req, res),
);
httpsServer.on('upgrade', upgrade);
const httpServer = http.createServer((req, res) => void handle(req, res));
httpServer.on('upgrade', upgrade);
await new Promise((r) => httpsServer.listen(HTTPS_PORT, 'localhost', r));
await new Promise((r) => httpServer.listen(HTTP_PORT, 'localhost', r));
const HTTPS_BASE = `https://localhost:${HTTPS_PORT}`;
const HTTP_BASE = `http://localhost:${HTTP_PORT}`;

// --- 場面 ---

let project;

async function step(promise, name) {
    try {
        return await promise;
    } catch (e) {
        throw new Error(`${name}: ${e.message.split('\n')[0]}`);
    }
}

// スマホの幅ではホスト名がアイコンだけになるので、ボタンの名前で見る（設定などのダイアログが開いていると
// 後ろは aria-hidden になるので、隠れたものも含める）
const connected = (page) =>
    step(
        page
            .getByRole('button', { name: /^書斎の PC につないでいます/, includeHidden: true })
            .first()
            .waitFor({ state: 'attached' }),
        'ホストにつなぐ',
    );

// 画面の IndexedDB に、届かなかった録音を入れる（#227。web/scripts/cloud-hosts.mjs と同じ）
async function seedUnsent(page, rows) {
    await page.evaluate(
        (rows) =>
            new Promise((resolve, reject) => {
                const req = indexedDB.open('remote-whisper', 1);
                req.onupgradeneeded = () =>
                    req.result.createObjectStore('unsentChunks', { keyPath: ['session', 'seq'] });
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                    const tx = req.result.transaction('unsentChunks', 'readwrite');
                    for (const r of rows) {
                        tx.objectStore('unsentChunks').put({
                            session: r.session,
                            seq: 0,
                            project: 'p',
                            host: r.host,
                            frame: new ArrayBuffer(4 + 16000 * 2),
                        });
                    }
                    tx.oncomplete = () => {
                        req.result.close();
                        resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                };
            }),
        rows,
    );
}

// 録音で作ったセッション（録音の場面のあとに、浄書・要約の場面で使う）
let recorded = null;

const scenes = [
    {
        name: 'ログイン',
        state: { me: null },
        open: (page) => step(page.getByText('Google でログイン').waitFor(), 'ログインのボタン'),
    },
    {
        name: '同意',
        state: { me: { ...ME, tosVersion: null }, hosts: [host(HOST_A, '書斎の PC', true)] },
        open: async (page) => {
            await step(page.getByRole('button', { name: '同意して進む' }).waitFor(), '同意のボタン');
        },
    },
    {
        name: 'ホストの選択（0 台）',
        state: { me: ME, hosts: [] },
        open: (page) => step(page.locator('[data-hosts=none]').waitFor(), '登録の案内'),
    },
    {
        name: 'ホストの選択（2 台）',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true), host(HOST_B, 'ノート PC', false)] },
        open: async (page) => {
            await step(page.locator('[data-hosts=choose]').waitFor(), '選ぶ画面');
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await connected(page);
        },
    },
    {
        name: '録音（WebSocket・AudioWorklet）',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        path: () => `/p/${project.uuid}/new`,
        open: async (page) => {
            await connected(page);
            await step(page.getByLabel('クリックして録音開始').click(), '録音を始める');
            await step(
                page.getByText('今日はリリース計画について', { exact: false }).first().waitFor({ timeout: 30000 }),
                '文字起こしが届く',
            );
            await page.waitForTimeout(3000);
            await step(page.getByLabel('クリックして録音終了').click(), '録音を終える');
            // 最終要約ができるまで待つ（モックは数秒）
            await page.getByRole('tab', { name: '要約' }).click();
            await step(page.getByText('決まったこと').first().waitFor({ timeout: 60000 }), '最終要約');
            const sessions = await api('GET', `/api/projects/${project.id}/sessions`);
            recorded = sessions.at?.(0) ?? sessions.sessions?.[0] ?? null;
        },
    },
    {
        name: '要約・浄書・録音の再生',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        path: () => (recorded?.uuid ? `/s/${recorded.uuid}` : `/p/${project.uuid}/new`),
        before: () => {
            // モックは浄書を作らないので、浄書済み文字起こしのファイルを置く（形は server の documents.py）
            if (!recorded) {
                throw new Error('録音の場面で作ったセッションがありません');
            }
            const sid = recorded.id;
            fs.writeFileSync(
                path.join(home, 'projects', project.id, `transcript-final-${sid}-${sid}.md`),
                `---\nid: '${sid}'\ngenerationId: '${sid}'\nmodel: large-v3-turbo\ngeneratedAt: '2026-11-01T10:00:00+09:00'\ndiarization: done\nspeakers: 2\n---\n[00:00:03] 話者 1: 今日はリリース計画について決めていきたいと思います。\n[00:00:09] 話者 2: まずステージング環境での確認です。\n`,
            );
        },
        open: async (page) => {
            await connected(page);
            await step(page.getByText('まずステージング環境での確認です').first().waitFor(), '浄書済み文字起こし');
            await page.getByRole('tab', { name: '要約' }).click();
            await step(page.getByText('決まったこと').first().waitFor(), '要約');
            await page.getByRole('tab', { name: '文字起こし' }).click();
            // 録音の再生（media-src）
            const play = page.getByRole('button', { name: /再生/ }).first();
            if (await play.isVisible().catch(() => false)) {
                await play.click().catch(() => {});
                await page.waitForTimeout(1000);
            }
        },
    },
    {
        name: '参考資料',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        path: () => `/p/${project.uuid}/new`,
        open: async (page) => {
            await connected(page);
            await page.locator('[data-slot=sheet-trigger]').first().click();
            await step(page.getByRole('button', { name: '資料を選んで新しく作る' }).click(), '資料を選んで新しく作る');
            await step(page.getByText('release-plan.md').click(), '資料のファイル');
            await page.waitForTimeout(500);
        },
    },
    ...['models', 'materials', 'recording', 'whisper', 'ollama', 'storage', 'display', 'setup'].map((p) => ({
        name: `設定（${p}）${p === 'setup' ? '・セットアップ（#291）' : ''}`,
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        path: () => `/settings/${p}`,
        open: async (page) => {
            await connected(page);
            await step(page.getByRole('tabpanel').first().waitFor(), '設定のページ');
            await page.waitForTimeout(500);
        },
    })),
    {
        name: 'すべての端末からログアウト（#250）',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        mobile: false,
        open: async (page) => {
            await connected(page);
            await page.getByRole('button', { name: 'アカウント', exact: true }).click();
            await page.getByRole('dialog', { name: 'アカウント' }).waitFor();
            await page.getByRole('button', { name: 'すべての端末からログアウト' }).click();
            await page.getByRole('button', { name: 'ログアウトする' }).click();
            await step(page.getByText('Google でログイン').waitFor(), 'ログインの画面に戻る');
        },
    },
    {
        name: '登録の確認と接続元の警告（#251）',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)], countryMismatch: true },
        path: () => '/pair?code=K7QM-4PXD',
        open: async (page) => {
            await step(page.getByRole('button', { name: '承認する' }).waitFor(), '承認のボタン');
            await step(page.locator('[data-pair-warning=country]').waitFor(), '接続元の警告');
        },
    },
    {
        name: '届かなかった録音の警告（#227）',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true), host(HOST_B, 'ノート PC', true)] },
        open: async (page) => {
            await page.locator('[data-hosts=choose]').waitFor();
            await page.getByRole('button', { name: /書斎の PC/ }).click();
            await connected(page);
            await seedUnsent(page, [{ session: 's-b', host: HOST_B }]);
            await page.reload();
            await step(page.getByText('ノート PC に届かなかった録音があります').waitFor(), '警告');
        },
    },
    {
        name: 'PWA の更新',
        state: { me: ME, hosts: [host(HOST_A, '書斎の PC', true)] },
        base: HTTP_BASE,
        open: async (page) => {
            await connected(page);
            await step(
                page.evaluate(async () => {
                    const r = await navigator.serviceWorker.ready;
                    return r.active?.state;
                }),
                'service worker が動く',
            );
            swVersion++;
            // 新しい版を確かめさせる（画面の 1 時間ごとの確かめと同じ registration.update()。読み込み直しでの
            // 確かめは、WebKit では来ないことがある）。知らせが出るまで何度か確かめ直す
            const notice = page.getByText('新しいバージョンの画面があります');
            for (let i = 0; i < 10 && !(await notice.isVisible()); i++) {
                await page
                    .evaluate(async () => {
                        const r = await navigator.serviceWorker.getRegistration();
                        await r?.update();
                    })
                    .catch(() => {});
                await page.waitForTimeout(2000);
            }
            await step(notice.waitFor({ timeout: 5000 }), '更新の知らせ');
            // 更新すると新しい版が動き出す。画面の外から update() したときは workbox-window が自分では読み込み直さない
            // ことがあるので、少し待ってから読み込み直し、新しい版で開けることを見る
            await page.getByRole('button', { name: '更新', exact: true }).click();
            await page.waitForTimeout(3000);
            await page.reload();
            await connected(page);
            await step(
                page.waitForFunction(async () => {
                    const r = await navigator.serviceWorker.getRegistration();
                    return r?.active && !r.waiting;
                }),
                '新しい版の service worker が動く',
            );
        },
    },
];

// --- ページの中で違反を拾う ---

const collect = () => {
    window.__csp = [];
    document.addEventListener(
        'securitypolicyviolation',
        (e) =>
            window.__csp.push({
                directive: e.effectiveDirective,
                blocked: e.blockedURI,
                disposition: e.disposition,
                source: `${e.sourceFile}:${e.lineNumber}`,
                sample: e.sample,
            }),
        true,
    );
};

const CSP_CONSOLE = /Content[- ]Security[- ]Policy|Refused to/i;
// 違反ではない知らせ（WebKit: report-uri のない Report-Only は効かない、という注意）
const CSP_NOTICE = /delivered in report-only mode, but does not specify/i;
const isCspConsole = (text) => CSP_CONSOLE.test(text) && !CSP_NOTICE.test(text);

async function runScene(browser, browserName, scene, { mobile }) {
    state = { scene: scene.name, ...structuredClone(scene.state ?? {}) };
    scene.before?.();
    const base = scene.base ?? HTTPS_BASE;
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: mobile ? { width: 375, height: 740 } : { width: 1280, height: 800 },
        ...(mobile && browserName === 'chromium' ? { isMobile: true, hasTouch: true } : {}),
        permissions: browserName === 'chromium' ? ['microphone', 'notifications'] : [],
        serviceWorkers: 'allow',
    });
    await context.addInitScript(collect);
    const page = await context.newPage();
    const consoleCsp = [];
    const pageErrors = [];
    page.on('console', (m) => isCspConsole(m.text()) && consoleCsp.push(m.text()));
    page.on('pageerror', (e) => pageErrors.push(e.message.split('\n')[0]));
    const before = reports.length;
    let error = null;
    let violations = [];
    try {
        await page.goto(new URL(scene.path?.() ?? '/', base).toString());
        await scene.open(page, { mobile });
        // 報告が届くのを少し待つ
        await page.waitForTimeout(1500);
        violations = await page.evaluate(() => window.__csp ?? []);
    } catch (e) {
        error = e.message.split('\n')[0];
        violations = await page.evaluate(() => window.__csp ?? []).catch(() => []);
    }
    await context.close();
    return { violations, reports: reports.slice(before), consoleCsp, pageErrors, error };
}

// わざと違反を起こす。拾えること、強制なら止まること、/csp-report に届くこと、iframe に入れられないこと
async function control(browser) {
    state = { scene: '陽性対照', me: ME, hosts: [host(HOST_A, '書斎の PC', true)] };
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    await context.addInitScript(collect);
    const page = await context.newPage();
    const before = reports.length;
    await page.goto(`${HTTPS_BASE}/`);
    await connected(page);
    const result = await page.evaluate(async () => {
        const s = document.createElement('script');
        s.textContent = 'window.__injected = 1';
        document.head.append(s);
        const img = new Image();
        img.src = 'https://example.invalid/x.png';
        document.body.append(img);
        await new Promise((r) => setTimeout(r, 500));
        return { injected: window.__injected === 1, violations: window.__csp.map((v) => v.directive) };
    });
    // iframe に入れる（frame-ancestors 'none' と X-Frame-Options）
    const framed = await context.newPage();
    await framed.setContent(`<iframe id="f" src="${HTTPS_BASE}/"></iframe>`);
    await framed.waitForTimeout(2000);
    const frameLoaded = await framed
        .frames()
        .find((f) => f.url().startsWith(HTTPS_BASE))
        ?.evaluate(() => document.querySelector('#root') !== null)
        .catch(() => false);
    // 報告は Reporting API だと少し遅れて届く
    for (let i = 0; i < 40 && reports.length - before < 2; i++) {
        await page.waitForTimeout(500);
    }
    await context.close();
    return { ...result, frameLoaded: frameLoaded ?? false, reports: reports.slice(before) };
}

function describeReport(r) {
    const body = r.report?.['csp-report'] ?? r.report?.body ?? {};
    const directive = body['effective-directive'] ?? body.effectiveDirective ?? body['violated-directive'];
    const blocked = body['blocked-uri'] ?? body.blockedURL;
    return `${r.type.split(';')[0]} ${directive} ${blocked}`;
}

// --- 動かす ---

await waitForServer();
await api('PATCH', '/api/settings', { materials: { roots: [tmp] } });
project = await api('POST', '/api/projects', { path: projectDir });

const only = args.only?.split(',').filter(Boolean) ?? null;
const picked = scenes.filter((s) => !only || only.some((o) => s.name.includes(o)));
const launchers = { chromium, webkit };
let failed = 0;
try {
    for (const name of args.browsers.split(',')) {
        const browser = await launchers[name].launch(
            name === 'chromium'
                ? {
                      executablePath: process.env.CHROMIUM_PATH || undefined,
                      args: [
                          '--use-fake-ui-for-media-stream',
                          '--use-fake-device-for-media-stream',
                          // Reporting API の報告を待たずに送らせる
                          '--short-reporting-delay',
                          // 自己署名の証明書でも service worker を登録できるように（PWA の場面は HTTP で見る）
                          '--ignore-certificate-errors',
                      ],
                  }
                : {},
        );
        console.log(`\n== ${name} ${browser.version()} ==`);
        const c = await control(browser);
        const ok =
            c.violations.includes('script-src-elem') &&
            c.violations.includes('img-src') &&
            c.injected === !enforced &&
            !c.frameLoaded &&
            // report-uri があれば、/csp-report に届くこと
            (!/report-uri/.test(csp) || c.reports.length > 0);
        console.log(
            `${ok ? 'OK  ' : 'FAIL'} 陽性対照: 拾った ${c.violations.join(',') || 'なし'}、スクリプトは${c.injected ? '動いた' : '止まった'}、iframe は${c.frameLoaded ? '開けた' : '開けない'}、報告 ${c.reports.length} 件（${[...new Set(c.reports.map(describeReport))].join(' / ') || 'なし'}）`,
        );
        if (!ok) {
            failed++;
        }
        for (const scene of picked) {
            for (const mobile of scene.mobile === false ? [false] : [false, true]) {
                if (scene.name.startsWith('録音') && mobile) {
                    // 録音は 1 回だけ（セッションを作るため）
                    continue;
                }
                if (scene.name.startsWith('録音') && name === 'webkit') {
                    // WebKit はマイクの偽物がない。WebSocket は ほかの場面（つなぐたびに /h/<id>/ws）で見る
                    continue;
                }
                const r = await runScene(browser, name, scene, { mobile });
                const bad = r.violations.length + r.reports.length + r.consoleCsp.length;
                const label = `${scene.name}${mobile ? '（スマホの幅）' : ''}`;
                if (bad || r.error) {
                    failed++;
                    console.log(`FAIL ${label}${r.error ? `: ${r.error}` : ''}`);
                    for (const v of r.violations) {
                        console.log(`     違反 ${v.disposition} ${v.directive} ${v.blocked} ${v.source} ${v.sample}`);
                    }
                    for (const rep of r.reports) {
                        console.log(`     報告 ${describeReport(rep)}`);
                    }
                    for (const m of r.consoleCsp) {
                        console.log(`     コンソール ${m.slice(0, 200)}`);
                    }
                } else {
                    console.log(`OK   ${label}`);
                }
                for (const e of r.pageErrors) {
                    console.log(`     （ページのエラー ${e.slice(0, 160)}）`);
                }
            }
        }
        const ws = upgrades.filter((u) => u.url.startsWith('/h/')).length;
        console.log(`     WebSocket（/h/<id>/ws）のつなぎ: ${ws} 回`);
        upgrades = [];
        await browser.close();
    }
} finally {
    httpsServer.close();
    httpServer.close();
    server.kill();
    await new Promise((r) => setTimeout(r, 500));
    fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} 件 FAIL` : '\nすべて OK');
console.log(`CSP: ${csp}`);
process.exit(failed ? 1 : 0);
