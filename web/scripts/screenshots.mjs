// 説明用のスクリーンショットを撮る
//
// 準備（別々のターミナルで）:
//   cd server && uv run remote-whisper --mock --mock-live-summary-sec 5
//   cd web && npm run dev
// 撮る:
//   cd web && npm run screenshots                       README と仕様書に載せるものだけ、docs/images/ に
//   cd web && npm run screenshots -- --all --out <dir>  公式 HP の「使い方」で使うものも全部、<dir> に
//
// オプション:
//   --all            全部の場面を撮る（既定は README に載せるものだけ）
//   --out <dir>      保存先（既定: docs/images）
//   --only <a,b>     名前に a か b を含む場面だけ撮る（撮り直し用）
//   --layouts <a,b>  desktop-light・desktop-dark・mobile-light・mobile-dark のどれを撮るか（既定: 全部）
//
// 環境変数:
//   SCREENSHOT_URL     画面の URL（既定: http://localhost:5173）
//   SCREENSHOT_SERVER  モックサーバーの URL（既定: http://localhost:8000）。クラウド版の場面で、ホスト宛ての通信をここへ流す
//   CHROMIUM_PATH      使う Chromium の実行ファイル（省略すると Playwright のもの。`npx playwright install chromium` で入る）
//
// 画面のデータは web/src/mock.ts のダミー（架空の打ち合わせと講義）と、モックサーバーが流すダミーの文字起こし・要約
// （URL に ?demo を付けて開くと、サーバーのデータではなく mock.ts のダミーを出す）。
// ダミーにない状態（再生できる録音・浄書済み文字起こし・GPU のジョブなど）は、画面のストア（window.appStore）に直接入れて作る。
// クラウド版の場面は、このスクリプトがクラウド用のドメインとして localhost の開発サーバーを別に立て、
// Worker の API（/me・/me/hosts など）は偽の返事にし、ホスト宛て（/h/<id>/...）はモックサーバーへ流す
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values: args } = parseArgs({
    options: {
        all: { type: 'boolean', default: false },
        out: { type: 'string' },
        only: { type: 'string' },
        layouts: { type: 'string' },
    },
});

const url = process.env.SCREENSHOT_URL ?? 'http://localhost:5173';
const serverUrl = process.env.SCREENSHOT_SERVER ?? 'http://localhost:8000';
const outDir = path.resolve(args.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../../docs/images'));
fs.mkdirSync(outDir, { recursive: true });
const only = args.only?.split(',').filter(Boolean) ?? null;

const layouts = {
    desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
    mobile: { viewport: { width: 375, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const variants = ['desktop-light', 'desktop-dark', 'mobile-light', 'mobile-dark'].filter(
    (v) => !args.layouts || args.layouts.split(',').includes(v),
);

// README と仕様書に載せる画像（--all でないときは、これだけ撮る）
const docsShots = new Set([
    'transcript',
    'summary',
    'recording',
    'recording-summary',
    'quick-settings',
    'settings',
    'materials',
    'new-project',
    'sidebar',
]);

// 場面。open で画面を作り、終わったら場面の名前で撮る。途中で shot(名前) を呼んで何枚も撮るものは manual にする。
// cloud はクラウド版の画面で撮る。desktopOnly はデスクトップでしか起きない操作
const scenes = [
    // --- README・仕様書（HP でも使う） ---
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
        // 録音を始めてから最終要約ができるまでを続けて撮る（Get Started・録音・一時停止・終了・うまく動かないとき）
        name: 'recording',
        manual: true,
        shots: [
            'recording',
            'recording-summary',
            'mic-recording',
            'paused',
            'mic-paused',
            'recording-lock-materials',
            'recording-lock-settings',
            'recording-lock-models',
            'recording-elsewhere',
            'mic-stopped',
            'transcription-stalled',
            'transcript-waiting',
            'server-error-recording',
            'server-error-recording-summary',
            'finishing',
            'finishing-summary',
            'finished',
            'finished-summary',
            'continue-mic',
        ],
        async open(page, { mobile, shot, all }) {
            await openNewSession(page, mobile, 'meetings');
            await page.getByLabel('クリックして録音開始').click();
            // 途中の要約（モックサーバーは --mock-live-summary-sec の間隔で送る）が届くまで待つ
            await page.waitForFunction(() => recordingSession()?.liveSummary, null, { timeout: 30000 });
            await waitForPartial(page);
            // 待つと区間が確定してしまうので、すぐ撮る
            await shot('recording', { wait: 0 });
            await shot('mic-recording', { wait: 0, clip: micClip });
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('recording-summary');
            if (all) {
                await recordingExtras(page, { mobile, shot });
            }
            await page.getByLabel('クリックして録音終了').click();
            if (!all) {
                // stop が届く前に閉じると、モックサーバーがセッションを 60 秒持ち続けて次の録音を始められない
                await page.waitForTimeout(1500);
                return;
            }
            // 最終要約を作っている途中
            await page.waitForFunction(() => window.appStore.getState().generating, null, { timeout: 30000 });
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('finishing-summary', { wait: 300 });
            await page.getByRole('tab', { name: '文字起こし' }).click();
            await shot('finishing', { wait: 300 });
            // 最終要約ができた後
            await page.waitForFunction(
                () => !window.appStore.getState().generating && recordingSession(true)?.summaries.length > 0,
                null,
                { timeout: 60000 },
            );
            await shot('finished');
            await shot('continue-mic', { clip: micClip });
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('finished-summary');
        },
    },
    {
        // 上の「モデル」から、設定の「モデル」ページを開いたところ
        name: 'quick-settings',
        async open(page, { mobile }) {
            await openSession(page, mobile, 'アルゴリズム 二分探索');
            await page.getByRole('button', { name: /^モデルの設定を開く/ }).click();
        },
    },
    {
        name: 'settings',
        async open(page, { mobile }) {
            await openSettings(page, mobile, '要約');
        },
    },
    {
        name: 'materials',
        async open(page, { mobile }) {
            await openNewSession(page, mobile, 'meetings');
            await openMaterialsMenu(page);
            await page.getByRole('button', { name: '資料を選んで新しく作る' }).click();
            // プロジェクトのフォルダ（meetings）は開いた状態で出る
            await page.getByText('release-plan.md').click();
        },
    },
    {
        name: 'new-project',
        async open(page, { mobile }) {
            await openMenu(page, mobile);
            await page.getByRole('button', { name: '新規プロジェクト作成' }).click();
            await page.getByText('interviews', { exact: true }).click();
        },
    },
    {
        // デスクトップはサイドバーを閉じた状態、スマホはサイドバー（メニュー）を開いた状態
        name: 'sidebar',
        async open(page, { mobile }) {
            await openSession(page, mobile, '新機能のリリース計画');
            if (mobile) {
                await page.getByLabel('メニューを開く').click();
            } else {
                await page.keyboard.press('Control+b');
            }
        },
    },

    // --- Get Started ---
    {
        // 何も選んでいない画面
        name: 'home',
        async open() {},
    },
    {
        // 初めて開いたとき（プロジェクトがない）
        name: 'no-projects',
        async open(page) {
            await page.evaluate(() => window.appStore.getState().setNoProjects(true));
        },
    },
    {
        // 新規セッション画面（録音前）
        name: 'new-session',
        manual: true,
        shots: ['new-session', 'mic-idle', 'new-session-summary'],
        async open(page, { mobile, shot }) {
            await openNewSession(page, mobile, 'meetings');
            await shot('new-session');
            await shot('mic-idle', { clip: micClip });
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('new-session-summary');
        },
    },
    {
        // プロジェクトのセッションを開いているときのマイクボタン（押すと新しいセッション）
        name: 'mic-new-session',
        async open(page, { mobile }) {
            await openSession(page, mobile, '週次の進捗確認');
        },
        clip: micClip,
    },

    // --- 続きから録音する ---
    {
        // 途中で終わったセッションの「続きから録音」
        name: 'continue',
        async open(page, { mobile }) {
            await openSession(page, mobile, 'デザインの方向性の相談');
        },
    },

    // --- 音声ファイルから文字起こし ---
    {
        name: 'upload',
        manual: true,
        shots: ['upload', 'uploading', 'upload-processing', 'upload-processing-summary'],
        async open(page, { mobile, shot }) {
            await openNewSession(page, mobile, 'lectures');
            await shot('upload', { clip: (p) => p.getByRole('button', { name: '音声ファイルから作る' }), pad: 12 });
            await page.evaluate(() =>
                window.appStore.setState({
                    uploading: { projectId: 'D--work-lectures-d4e5f6', name: 'lecture-1016.m4a', percent: 42 },
                }),
            );
            await shot('uploading');
            // アップロードを終えて、浄書・要約を作っているところ
            await page.evaluate(() => {
                const s = window.appStore.getState();
                const id = '20261016-090000';
                const session = {
                    id,
                    title: 'lecture-1016',
                    uploaded: true,
                    startedAt: '2026-10-16 09:00',
                    status: 'done',
                    loaded: true,
                    // files を入れると、文字起こしがまだないのを「期限切れ」と出してしまうので入れない
                    transcript: [],
                    summaries: [],
                };
                window.appStore.setState({
                    uploading: null,
                    projects: s.projects.map((p) =>
                        p.id === 'D--work-lectures-d4e5f6' ? { ...p, sessions: [session, ...p.sessions] } : p,
                    ),
                    options: { ...s.options, whisper: { ...s.options.whisper, finalTranscript: true } },
                    server: {
                        ...s.server,
                        transcribing: [id],
                        jobs: {
                            running: { kind: 'finalTranscript', session: id, runningSec: 48 },
                            waiting: [{ kind: 'finalSummary', session: id, count: 1, waitingSec: 48 }],
                        },
                        jobsAt: Date.now(),
                    },
                });
                s.selectSession('D--work-lectures-d4e5f6', id);
            });
            await shot('upload-processing');
            await page.getByRole('tab', { name: '要約' }).click();
            await shot('upload-processing-summary');
        },
    },

    // --- 間違った語を直す ---
    {
        name: 'correction',
        manual: true,
        shots: ['correction-select', 'correction-confirm', 'correction-done'],
        async open(page, { mobile, shot }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await selectText(page, '負荷試験は外部', '外部');
            const input = page.locator('#correction-right');
            await input.waitFor();
            await shot('correction-select');
            await input.fill('外注');
            await input.press('Enter');
            await shot('correction-confirm');
            await page.getByRole('button', { name: '全部', exact: true }).click();
            await shot('correction-done', { wait: 1000 });
        },
    },
    {
        // 用語リスト（手で足した語・文字起こしから拾った語・置き換え）
        name: 'terms',
        async open(page, { mobile }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await patchSession(page, '新機能のリリース計画', {
                manualTerms: ['ステージング環境'],
                pickedTerms: ['負荷試験', 'リリース計画', '見積もり'],
                corrections: [{ from: '外部の', to: '外注の', line: null }],
            });
            await patchSettings(page, { display: { showPickedTerms: true } });
        },
    },

    // --- 録音を聞き直す ---
    {
        name: 'playback',
        manual: true,
        shots: ['playback', 'playback-rate', 'playback-return'],
        async open(page, { mobile, shot }) {
            await routeRecording(page);
            await openSession(page, mobile, '新機能のリリース計画');
            await patchSession(page, '新機能のリリース計画', {
                transcript: longTranscript,
                files: { recording: true, transcript: true, summaries: 1, liveSummary: true },
            });
            await page.getByLabel('録音を再生').waitFor();
            await page.getByLabel('00:01:40 から再生').click();
            await page.waitForTimeout(1500);
            // 再生したまま撮る（止めると再生位置の行の目立たせ方が変わる）
            await shot('playback');
            await page.getByLabel(/^再生速度/).click();
            await shot('playback-rate');
            await page.keyboard.press('Escape');
            // 自分でスクロールして再生位置から離れると、「再生位置に戻る」が出る
            // （スマホの幅ではホイールが届かないので、人の操作の合図と、スクロールそのものを別々に起こす）
            await page.evaluate(() => {
                window.dispatchEvent(new Event('touchmove'));
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.getByRole('button', { name: '再生位置に戻る' }).waitFor({ timeout: 5000 });
            await shot('playback-return');
        },
    },

    // --- 浄書済み文字起こしを作り直す ---
    {
        name: 'final-transcript',
        manual: true,
        shots: [
            'final-transcript',
            'final-transcript-versions',
            'final-transcript-making',
            'final-transcript-missing',
            'final-transcript-none',
        ],
        async open(page, { mobile, shot }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({
                    options: { ...s.options, whisper: { ...s.options.whisper, finalTranscript: true } },
                });
            });
            await patchSettings(page, { display: { showSpeakers: true } });
            await patchSession(page, '新機能のリリース計画', {
                files: { recording: true, transcript: true, summaries: 1, liveSummary: true },
                finalTranscripts: [
                    { ...finalInfo, generationId: '20261009-150210', generatedAt: '2026-10-09 15:02' },
                    { ...finalInfo, generationId: '20261010-091500', generatedAt: '2026-10-10 09:15' },
                ],
                finalTranscript: {
                    ...finalInfo,
                    generationId: '20261010-091500',
                    generatedAt: '2026-10-10 09:15',
                    lines: finalLines,
                },
            });
            await shot('final-transcript');
            await page.getByLabel('表示する浄書済み文字起こし').click();
            await shot('final-transcript-versions');
            await page.keyboard.press('Escape');
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({ server: { ...s.server, transcribing: ['20261009-143012'] } });
            });
            await shot('final-transcript-making');
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({ server: { ...s.server, transcribing: [] } });
            });
            await patchSettings(page, { whisper: { model: 'large-v3' } });
            await shot('final-transcript-missing');
            await patchSettings(page, { whisper: { model: 'large-v3-turbo' } });
            await patchSession(page, '新機能のリリース計画', { finalTranscripts: [], finalTranscript: undefined });
            await shot('final-transcript-none');
        },
    },

    // --- 要約を作り直す・版を切り替える・コピー ---
    {
        name: 'summary-versions',
        manual: true,
        shots: [
            'summary-versions',
            'summary-regenerating',
            'summary-missing',
            'summary-failed',
            'summary-copy',
            'summary-copied',
        ],
        async open(page, { mobile, shot }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await page.getByRole('tab', { name: '要約' }).click();
            const text = await page.evaluate(() => currentSessionOf()?.summaries[0].text);
            await patchSession(page, '新機能のリリース計画', {
                files: { recording: true, transcript: true, summaries: 2, liveSummary: true },
                summaries: [
                    { generationId: 'a', model: 'gemma3:4b', generatedAt: '2026-10-09 14:58', text },
                    { generationId: 'b', model: 'qwen3.5:4b', generatedAt: '2026-10-10 09:20', text },
                ],
            });
            await shot('summary-copy', { clip: (p) => p.getByRole('button', { name: 'コピー' }), pad: 12 });
            await page.getByLabel('表示する要約').click();
            await shot('summary-versions');
            await page.keyboard.press('Escape');
            await page.evaluate((t) => {
                window.appStore.setState({
                    generating: { sessionId: '20261009-143012', model: 'qwen3.5:4b', text: t.slice(0, 40) },
                });
            }, text);
            await shot('summary-regenerating');
            await page.evaluate(() => window.appStore.setState({ generating: null }));
            await patchSettings(page, { ollama: { models: { detail: 'qwen3.5:2b', overview: 'qwen3.5:2b' } } });
            await shot('summary-missing');
            await patchSettings(page, { ollama: { models: { detail: 'qwen3.5:4b', overview: 'qwen3.5:4b' } } });
            await patchSession(page, '新機能のリリース計画', { summaryFailed: true });
            await shot('summary-failed');
            await patchSession(page, '新機能のリリース計画', { summaryFailed: false });
            await page.getByRole('button', { name: 'コピー' }).click();
            await shot('summary-copied');
        },
    },

    // --- 参考資料を作る ---
    {
        // 上の「参考資料」を押したところ
        name: 'materials-menu',
        async open(page, { mobile }) {
            await openNewSession(page, mobile, 'meetings');
            await openMaterialsMenu(page);
        },
    },
    {
        name: 'materials-generating',
        async open(page, { mobile }) {
            await openNewSession(page, mobile, 'meetings');
            await page.evaluate(() => {
                const s = window.appStore.getState();
                const pid = 'D--work-meetings-a1b2c3';
                const set = {
                    id: '20261016-100000',
                    status: 'generating',
                    materials: ['D:\\work\\meetings\\release-plan.md', 'D:\\work\\meetings\\glossary.txt'],
                };
                window.appStore.setState({
                    contextSets: { ...s.contextSets, [pid]: [...(s.contextSets[pid] ?? []), set] },
                    contextSelections: {
                        ...s.contextSelections,
                        [pid]: { ...s.contextSelections[pid], setId: set.id },
                    },
                    server: {
                        ...s.server,
                        jobs: { running: { kind: 'contextSet', session: null, runningSec: 35 }, waiting: [] },
                        jobsAt: Date.now(),
                    },
                });
            });
            await openMaterialsMenu(page);
        },
    },

    // --- プロジェクトを作る・並び替える ---
    {
        name: 'project-reorder',
        manual: true,
        shots: ['project-grip', 'project-reordering'],
        async open(page, { mobile, shot }) {
            await openMenu(page, mobile);
            const grip = page.getByLabel('lecturesの並び順を変える');
            await page.getByText('lectures', { exact: true }).hover();
            await grip.focus();
            await shot('project-grip');
            // キーボードで持ち上げて動かす（マウス・指でのドラッグと同じ表示になる）
            await page.keyboard.press('Space');
            await page.keyboard.press('ArrowUp');
            await shot('project-reordering');
            await page.keyboard.press('Escape');
        },
    },

    // --- セッションを別のプロジェクトへ移す ---
    {
        name: 'move-session',
        manual: true,
        shots: ['move-dragging', 'move-done', 'move-blocked'],
        async open(page, { mobile, shot }) {
            await openMenu(page, mobile);
            const from = page.getByRole('button', { name: /週次の進捗確認/ }).first();
            const to = page.getByText('lectures', { exact: true });
            await dragAndShoot(page, mobile, from, to, () => shot('move-dragging'));
            await shot('move-done', { wait: 800 });
            // 要約を作っている途中のセッションは移せない（理由を Tooltip で出す）
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({ server: { ...s.server, summarizing: ['20261009-143012'] } });
            });
            const blocked = page.getByRole('button', { name: /新機能のリリース計画/ }).first();
            if (mobile) {
                await blocked.focus();
            } else {
                await blocked.hover();
            }
            await page
                .getByRole('tooltip')
                .first()
                .waitFor({ timeout: 5000 })
                .catch(() => {});
            await shot('move-blocked');
        },
    },

    // --- URL で画面を開く ---
    {
        name: 'not-found',
        path: '/s/00000000-0000-4000-8000-000000000000',
        async open() {},
    },

    // --- モデルの選び方・設定一覧 ---
    {
        // 入っていないモデルを選んでいるとき
        name: 'models-missing',
        async open(page) {
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({
                    options: {
                        ...s.options,
                        ollama: { models: s.options.ollama.models.filter((m) => m.name !== 'qwen3.5:4b') },
                    },
                    settingsPage: 'models',
                    settingsOpen: true,
                });
            });
        },
    },
    ...['models', 'materials', 'recording', 'whisper', 'ollama', 'storage', 'display'].map((key) => ({
        // 設定モーダルの各ページ。-full は縦に伸ばしてページ全体を撮ったもの
        name: `settings-${key}`,
        manual: true,
        shots: [`settings-${key}`, `settings-${key}-full`],
        path: `/settings/${key}`,
        async open(page, { shot }) {
            await page.getByRole('dialog').waitFor();
            await shot(`settings-${key}`);
            await shot(`settings-${key}-full`, { fullDialog: true });
        },
    })),

    // --- テーマ ---
    {
        name: 'theme-toggle',
        async open(page, { mobile }) {
            await openMenu(page, mobile);
        },
        clip: (page) => page.getByRole('button', { name: /^テーマ/ }),
        pad: 8,
    },

    // --- アプリとして使う ---
    {
        name: 'pwa-update',
        async open(page) {
            // 開発サーバーでは service worker が動かないので、PwaUpdater と同じ Toast を出す
            await toast(page, 'info', '新しいバージョンの画面があります', {
                description: '更新すると、読み込み直します',
                action: '更新',
            });
        },
    },

    // --- うまく動かないとき ---
    {
        // マイクが許可されていないとき
        name: 'mic-denied',
        async open(page, { mobile }) {
            await openNewSession(page, mobile, 'meetings');
            await patchServer(page, { microphone: 'denied' });
        },
    },
    {
        // 前に開いていたページで、送れていない音声が残っているとき
        name: 'unsent',
        async open(page) {
            await page.evaluate(() =>
                window.appStore.setState({
                    unsent: { sessionId: '20260925-150000', projectId: 'D--work-meetings-a1b2c3', seconds: 95 },
                }),
            );
        },
    },
    {
        // Whisper・Ollama が使えないとき（モックサーバーの状態を変える）
        name: 'server-error',
        manual: true,
        shots: ['server-error', 'server-error-gpu'],
        async open(page, { mobile, shot }) {
            await openNewSession(page, mobile, 'meetings');
            await setMockStatus(page, { whisper: 'error', ollama: 'error' });
            try {
                await page.waitForFunction(() => window.appStore.getState().server.whisper === 'error');
                await shot('server-error');
                await page.getByRole('button', { name: /^GPU/ }).click();
                await shot('server-error-gpu');
            } finally {
                await setMockStatus(page, { whisper: 'ready', ollama: 'ready' });
            }
        },
    },
    {
        // ホストにつながっていないとき
        name: 'reconnecting',
        async open(page, { mobile }) {
            await openSession(page, mobile, '週次の進捗確認');
            await patchServer(page, { connection: 'reconnecting' });
        },
    },
    {
        // GPU インジケータを開いたところ（実行中と待っているジョブ）
        name: 'gpu-jobs',
        async open(page, { mobile }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await patchServer(page, {
                gpu: { util: 87, memUsedMb: 6120, memTotalMb: 8192 },
                jobs: {
                    running: { kind: 'finalSummary', session: '20261009-130000', runningSec: 42 },
                    waiting: [
                        { kind: 'transcribe', session: '20261009-143012', count: 3, waitingSec: 12 },
                        { kind: 'finalTranscript', session: '20261008-090000', count: 1, waitingSec: 95 },
                    ],
                },
                jobsAt: Date.now(),
            });
            await page.getByRole('button', { name: /^GPU/ }).click();
        },
    },
    {
        // 古い画面のまま、消えた JS を読もうとして失敗したとき
        name: 'preload-error',
        async open(page) {
            await page.evaluate(() => window.dispatchEvent(new Event('vite:preloadError', { cancelable: true })));
        },
    },

    // --- ほかの端末で録音しているセッションを見る（#238） ---
    {
        name: 'watching',
        async open(page, { mobile }) {
            await openSession(page, mobile, '新機能のリリース計画');
            await patchSession(page, '新機能のリリース計画', { status: 'recording', provisionalTitle: true });
            await page.evaluate(() =>
                window.appStore.setState({ watching: { sessionId: '20261009-143012', state: 'recording' } }),
            );
        },
    },

    // --- 表示の設定 ---
    {
        // サイドバーに録音日時と長さを出したところ
        name: 'sidebar-meta',
        async open(page, { mobile }) {
            await patchSettings(page, { display: { sessionMeta: true } });
            await page.evaluate(() => {
                const s = window.appStore.getState();
                window.appStore.setState({
                    projects: s.projects.map((p) => ({
                        ...p,
                        sessions: p.sessions.map((x, i) => ({ ...x, durationSec: [3125, 1820, 2710][i] ?? 1500 })),
                    })),
                });
            });
            await openMenu(page, mobile);
        },
    },

    // --- クラウド版 ---
    {
        name: 'cloud-login',
        cloud: { me: null },
        async open(page) {
            await page.getByText('Google でログイン').waitFor();
        },
    },
    {
        name: 'cloud-consent',
        cloud: { me: { tosVersion: null } },
        async open(page) {
            await page.getByRole('button', { name: '同意して進む' }).waitFor();
        },
    },
    {
        name: 'cloud-hosts-none',
        cloud: { hosts: [] },
        async open(page) {
            await page.locator('[data-hosts=none]').waitFor();
        },
    },
    {
        name: 'cloud-hosts-choose',
        cloud: { hosts: 'two' },
        async open(page) {
            await page.locator('[data-hosts=choose]').waitFor();
        },
    },
    {
        // ホストにつないだ後の画面（上にホスト名）
        name: 'cloud-main',
        cloud: {},
        manual: true,
        shots: ['cloud-main', 'cloud-account', 'cloud-account-full'],
        async open(page, { mobile, shot }) {
            // ホストにつながると今の画面が出る（スマホの幅ではホスト名はアイコンだけ）
            await page.waitForFunction(() => window.appStore);
            await openSession(page, mobile, '新機能のリリース計画');
            await shot('cloud-main');
            // スマホの幅では、アカウントの画面がサイドバーのシートと一緒に閉じてしまう（アプリ側の不具合）ので撮らない
            if (mobile) {
                return;
            }
            await openMenu(page, mobile);
            await page.getByRole('button', { name: 'アカウント', exact: true }).click();
            await page.getByRole('dialog', { name: 'アカウント' }).waitFor();
            await page.getByText('書斎の PC').last().waitFor();
            await shot('cloud-account');
            await shot('cloud-account-full', { fullDialog: true });
        },
    },
    {
        name: 'cloud-announcement',
        cloud: {
            announcements: [
                {
                    id: 'release-2026-11',
                    kind: 'release',
                    title: '新しいバージョン 1.2.0 を公開しました',
                    url: 'https://example.com/news',
                    since: '2026-01-01',
                    until: '2099-12-31',
                    version: '1.2.0',
                },
            ],
        },
        async open(page) {
            await page.getByText('新しいバージョン 1.2.0 を公開しました').waitFor();
        },
    },
    {
        // ホストの登録の確認（トレイの「クラウド版にログイン」から開く画面）
        name: 'cloud-pair',
        cloud: {},
        path: '/pair?code=K7QM-4PXD',
        async open(page) {
            await page.getByRole('button', { name: '承認する' }).waitFor();
        },
    },
];

// 録音中に撮るもの（--all のとき）。最後は録音中のセッションの文字起こしタブに戻しておく
async function recordingExtras(page, { mobile, shot }) {
    await page.getByRole('tab', { name: '文字起こし' }).click();
    // 録音中に押せない項目（参考資料・設定）。押すと理由が出る
    await materialsButton(page).click({ force: true });
    await shot('recording-lock-materials', { wait: 500 });
    await dismissToasts(page);
    await openSettings(page, mobile, '文字起こし');
    await shot('recording-lock-settings');
    await page.getByRole('tab', { name: 'モデル' }).click();
    await shot('recording-lock-models');
    await page.keyboard.press('Escape');
    // 一時停止
    await page.getByLabel('クリックして一時停止').click();
    await shot('paused');
    await shot('mic-paused', { clip: micClip });
    await page.getByLabel('クリックして録音再開').click();
    // 録音中にほかのセッションを開いたところ（マイクボタンが「戻る」になる）
    await openSession(page, mobile, '週次の進捗確認');
    await shot('recording-elsewhere');
    await page.getByLabel(/クリックで戻ります$/).click();
    // マイクが止まった・文字起こしが出ない・ほかの処理を待っている
    await page.evaluate(() => window.appStore.setState({ micState: 'ended' }));
    await shot('mic-stopped');
    await page.evaluate(() => window.appStore.setState({ micState: 'ok', transcriptionStalled: true }));
    await shot('transcription-stalled');
    await page.evaluate(() => window.appStore.setState({ transcriptionStalled: false }));
    await page.evaluate(() => {
        const s = window.appStore.getState();
        window.appStore.setState({
            server: {
                ...s.server,
                jobs: {
                    running: { kind: 'liveSummary', session: s.recordingSessionId, runningSec: 8 },
                    waiting: [{ kind: 'transcribe', session: s.recordingSessionId, count: 2, waitingSec: 8 }],
                },
                jobsAt: Date.now(),
            },
        });
    });
    await shot('transcript-waiting', { wait: 300 });
    await page.evaluate(() => {
        const s = window.appStore.getState();
        window.appStore.setState({ server: { ...s.server, jobs: { running: null, waiting: [] } } });
    });
    // 録音中に Whisper・Ollama が使えなくなったとき（モックサーバーの状態を変える）
    await setMockStatus(page, { whisper: 'error', ollama: 'error' });
    try {
        await page.waitForFunction(() => window.appStore.getState().server.whisper === 'error');
        await shot('server-error-recording');
        await page.getByRole('tab', { name: '要約' }).click();
        await shot('server-error-recording-summary');
        await page.getByRole('tab', { name: '文字起こし' }).click();
    } finally {
        await setMockStatus(page, { whisper: 'ready', ollama: 'ready' });
    }
}

// --- 画面の操作 ---

// スマホの幅ではサイドバーが隠れているので、メニューを開く
async function openMenu(page, mobile) {
    if (mobile) {
        await page.getByLabel('メニューを開く').click();
    }
}

async function openSession(page, mobile, title) {
    await openMenu(page, mobile);
    await page.getByText(title, { exact: true }).click();
}

async function openNewSession(page, mobile, project) {
    await openMenu(page, mobile);
    await page.getByLabel(`${project}で新しく録音`).click();
}

async function openSettings(page, mobile, tab) {
    await openMenu(page, mobile);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await page.getByRole('tab', { name: tab }).click();
}

// 上の「参考資料」のボタン
const materialsButton = (page) => page.locator('[data-slot=sheet-trigger]');

async function openMaterialsMenu(page) {
    await materialsButton(page).click();
}

// 文字起こしの line を含む行の、part の部分を選ぶ（置き換えの入力欄を出す）
async function selectText(page, line, part) {
    await page.evaluate(
        ([line, part]) => {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const i = node.textContent.indexOf(line);
                if (i >= 0) {
                    const start = i + line.indexOf(part);
                    const range = document.createRange();
                    range.setStart(node, start);
                    range.setEnd(node, start + part.length);
                    const selection = window.getSelection();
                    selection.removeAllRanges();
                    selection.addRange(range);
                    node.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    node.parentElement.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
                    return;
                }
            }
            throw new Error(`見つかりません: ${line}`);
        },
        [line, part],
    );
}

// from を to へドラッグし、離す前に onHold を呼ぶ。マウスは少し動かすと、指は長押しするとドラッグが始まる
async function dragAndShoot(page, mobile, from, to, onHold) {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const end = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    if (!mobile) {
        await page.mouse.move(start.x, start.y);
        await page.mouse.down();
        for (let i = 1; i <= 10; i++) {
            await page.mouse.move(start.x + ((end.x - start.x) * i) / 10, start.y + ((end.y - start.y) * i) / 10);
        }
        await onHold();
        await page.mouse.up();
        return;
    }
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, p) =>
        cdp.send('Input.dispatchTouchEvent', {
            type,
            touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }],
        });
    await touch('touchStart', start);
    await page.waitForTimeout(600);
    for (let i = 1; i <= 10; i++) {
        await touch('touchMove', {
            x: start.x + ((end.x - start.x) * i) / 10,
            y: start.y + ((end.y - start.y) * i) / 10,
        });
    }
    await onHold();
    await touch('touchEnd', end);
}

async function dismissToasts(page) {
    await page.evaluate(async () => (await sonner()).toast.dismiss());
    await page.waitForTimeout(400);
}

// 画面と同じ sonner で Toast を出す（画面の操作では出しにくい通知を撮る）。消えないようにし、action はボタンの文字だけ
async function toast(page, kind, message, { description, action }) {
    await page.evaluate(
        async ([kind, message, description, action]) => {
            (await sonner()).toast[kind](message, {
                description,
                duration: Infinity,
                action: action && { label: action, onClick: () => {} },
            });
        },
        [kind, message, description, action],
    );
}

// --- ストアを直接変える ---

async function patchSession(page, title, patch) {
    await page.evaluate(
        ([title, patch]) => {
            const s = window.appStore.getState();
            window.appStore.setState({
                projects: s.projects.map((p) => ({
                    ...p,
                    sessions: p.sessions.map((x) => (x.title === title ? { ...x, ...patch } : x)),
                })),
            });
        },
        [title, patch],
    );
}

// 設定を一段深くまで混ぜて変える（ollama.models は二段）
async function patchSettings(page, patch) {
    await page.evaluate((patch) => {
        const s = window.appStore.getState();
        const settings = { ...s.settings };
        for (const [k, v] of Object.entries(patch)) {
            settings[k] = { ...settings[k], ...v };
            if (k === 'ollama' && v.models) {
                settings.ollama.models = { ...s.settings.ollama.models, ...v.models };
            }
        }
        window.appStore.setState({ settings });
    }, patch);
}

async function patchServer(page, patch) {
    await page.evaluate((patch) => {
        const s = window.appStore.getState();
        window.appStore.setState({ server: { ...s.server, ...patch } });
    }, patch);
}

async function setMockStatus(page, status) {
    const res = await page.request.post(`${serverUrl}/api/mock/status`, { data: status });
    if (!res.ok()) {
        throw new Error(`POST /api/mock/status: ${res.status()}`);
    }
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

// --- 撮る範囲 ---

// マイクボタンのまわり（経過時間・終了のボタンを含む）
function micClip(page) {
    return page.locator('[aria-label^="クリック"], [aria-label*="録音中です"], [aria-label*="選んでください"]').first();
}

// --- ダミーデータに足すもの ---

// 「再生位置に戻る」を出すため、スクロールできる長さにした文字起こし
const longTranscript = [
    ['00:00:03', '今日はリリース計画について決めていきたいと思います。'],
    ['00:00:15', 'まずステージング環境での確認ですが、来週の水曜までに終わらせる予定です。'],
    ['00:00:31', '確認の項目は前回のリリースと同じでいいですか。'],
    ['00:00:38', 'はい、ただ今回は決済まわりを触っているので、その項目を足します。'],
    ['00:00:52', '決済の確認は誰が担当しますか。'],
    ['00:00:57', 'バックエンドの二人で分けて見ます。'],
    ['00:01:02', '負荷試験はまだ手をつけていないので、そこが一番のリスクですね。'],
    ['00:01:14', '前回は本番の半分くらいの負荷で止めてしまったので、今回は本番と同じくらいまで上げたいです。'],
    ['00:01:29', 'それなら社内の環境だと足りないかもしれません。'],
    ['00:01:40', '負荷試験は外部のツールを使う方向で、見積もりを今週中にもらいます。'],
    ['00:01:55', '見積もりが高かったら、範囲を絞ってやることにしましょう。'],
    ['00:02:06', 'リリースノートの下書きは誰が書きますか。'],
    ['00:02:12', '私が書いて、金曜の朝に共有します。'],
    ['00:02:20', 'お客さま向けのお知らせも一緒にお願いします。'],
    ['00:02:31', 'リリース日は再来週の月曜を目標にして、金曜に最終判断しましょう。'],
    ['00:02:44', '最終判断の会議は金曜の十六時でいいですか。'],
    ['00:02:50', 'はい、カレンダーに入れておきます。'],
    ['00:02:58', '問題が出たときの切り戻しの手順も、それまでに確認しておきます。'],
    ['00:03:10', '切り戻しは前回少し手間取ったので、手順書を見直しておきます。'],
    ['00:03:24', 'では今日はここまでにしましょう。お疲れさまでした。'],
].map(([time, text]) => ({ time, text }));

const finalInfo = { model: 'large-v3-turbo', diarization: 'done', speakers: 2 };
const finalLines = [
    ['00:00:03', '話者 1: 今日はリリース計画について決めていきたいと思います。'],
    ['00:00:15', '話者 2: まずステージング環境での確認ですが、来週の水曜までに終わらせる予定です。'],
    ['00:01:02', '話者 2: 負荷試験はまだ手をつけていないので、そこが一番のリスクですね。'],
    ['00:01:40', '話者 1: 負荷試験は外部のツールを使う方向で、見積もりを今週中にもらいます。'],
    ['00:02:31', '話者 1: リリース日は再来週の月曜を目標にして、金曜に最終判断しましょう。'],
].map(([time, text]) => ({ time, text }));

// 再生バーに渡す録音（静かな音の WAV）。デモのセッションには録音がないので、取りに来たらこれを返す
function silentWav(seconds = 240, rate = 8000) {
    const n = seconds * rate;
    const buf = Buffer.alloc(44 + n);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + n, 4);
    buf.write('WAVEfmt ', 8);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate, 28);
    buf.writeUInt16LE(1, 32);
    buf.writeUInt16LE(8, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(n, 40);
    buf.fill(128, 44);
    return buf;
}

async function routeRecording(page) {
    const wav = silentWav();
    await page.route('**/recording', (route) =>
        route.fulfill({ status: 200, contentType: 'audio/wav', body: wav, headers: { 'Accept-Ranges': 'none' } }),
    );
}

// --- クラウド版 ---

const cloudPort = 5199;
let cloudServer = null;

// クラウド用のドメインとして localhost で開く開発サーバー（必要になったときだけ立てる）
async function cloudBaseUrl() {
    if (!cloudServer) {
        process.env.VITE_CLOUD_HOSTS = 'localhost';
        const { createServer } = await import('vite');
        cloudServer = await createServer({
            root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
            server: { port: cloudPort, strictPort: true },
            logLevel: 'error',
        });
        await cloudServer.listen();
    }
    return `http://localhost:${cloudPort}`;
}

const HOST_A = '11111111-1111-4111-8111-111111111111';
const HOST_B = '22222222-2222-4222-8222-222222222222';
const host = (id, name, online) => ({ id, name, appVersion: null, createdAt: 1760000000000, lastSeenAt: null, online });

// Worker の API を偽の返事にし、ホスト宛ての API と WebSocket はモックサーバーへ流す
async function routeCloud(page, options) {
    const me =
        options.me === null
            ? null
            : {
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
                  ...options.me,
              };
    const hosts =
        options.hosts === 'two'
            ? [host(HOST_A, '書斎の PC', true), host(HOST_B, 'ノート PC', false)]
            : (options.hosts ?? [host(HOST_A, '書斎の PC', true)]);
    await page.route(
        (u) => u.pathname === '/me',
        (route) => (me ? route.fulfill({ json: me }) : route.fulfill({ status: 401, json: { detail: 'login' } })),
    );
    await page.route('**/me/hosts', (route) => route.fulfill({ json: { hosts } }));
    await page.route('**/me/metrics/**', (route) => route.fulfill({ json: { ok: true } }));
    await page.route('**/announcements.json', (route) => route.fulfill({ json: options.announcements ?? [] }));
    await page.route('**/pair/request*', (route) =>
        route.fulfill({
            json: {
                code: 'K7QM-4PXD',
                hostName: '書斎の PC',
                status: 'pending',
                answeredByMe: null,
                expiresAt: Date.now() + 10 * 60 * 1000,
            },
        }),
    );
    await page.route(/\/h\/[^/]+\/api\//, async (route) => {
        const target = new URL(route.request().url());
        const rest = target.pathname.replace(/^\/h\/[^/]+/, '');
        const response = await route.fetch({ url: `${serverUrl}${rest}${target.search}` });
        await route.fulfill({ response });
    });
    await page.routeWebSocket(/\/h\/[^/]+\/ws/, (ws) => {
        ws.connectToServer(`${serverUrl.replace(/^http/, 'ws')}/ws`);
    });
}

// --- 撮る ---

// 縦に伸ばして、ダイアログの中身を全部撮る（スクロールしないと見えないところまで）
async function shootFullDialog(page, file) {
    const viewport = page.viewportSize();
    await page.setViewportSize({ width: viewport.width, height: 3000 });
    await page.evaluate(() => {
        // スマホの幅ではサイドバーもダイアログなので、一番手前（最後）のものを撮る
        const dialog = [...document.querySelectorAll('[role=dialog]')].at(-1);
        dialog.style.maxHeight = 'none';
        dialog.style.height = 'auto';
        for (const el of dialog.querySelectorAll('*')) {
            const style = getComputedStyle(el);
            if (/(auto|scroll)/.test(style.overflowY) || style.maxHeight !== 'none') {
                el.style.overflowY = 'visible';
                el.style.maxHeight = 'none';
            }
            if (el.matches('.min-h-0')) {
                el.style.minHeight = 'auto';
            }
        }
    });
    await page.waitForTimeout(500);
    await page.locator('[role=dialog]').last().screenshot({ path: file });
    await page.setViewportSize(viewport);
}

// ページの中で使う小道具（ストアのセッションを引く・sonner を読み込む）
const pageHelpers = () => {
    const sessions = () => window.appStore.getState().projects.flatMap((p) => p.sessions);
    // 録音中のセッション。録音を終えた後も、最後に録音したものを返す（ended）
    let last = null;
    window.recordingSession = (ended = false) => {
        const id = window.appStore.getState().recordingSessionId;
        if (id) {
            last = id;
        }
        return sessions().find((x) => x.id === (id ?? (ended ? last : null)));
    };
    window.currentSessionOf = () => sessions().find((x) => x.id === window.appStore.getState().selection.sessionId);
    // 画面が読み込んだのと同じ sonner（URL が同じなら同じモジュールになる）
    window.sonner = () => {
        const entry = performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .find((n) => /\/node_modules\/\.vite\/deps\/sonner\.js/.test(n));
        return import(/* @vite-ignore */ entry);
    };
};

const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    // 偽のマイクで録音する（許可のダイアログも出さない）
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

const wanted = (name) => args.all || docsShots.has(name);
const picked = scenes.filter((scene) => {
    const names = scene.shots ?? [scene.name];
    if (!names.some(wanted)) {
        return false;
    }
    return !only || only.some((o) => names.some((n) => n.includes(o)));
});

let failed = 0;
for (const variant of variants) {
    const [layoutName, colorScheme] = variant.split('-');
    const mobile = layoutName === 'mobile';
    for (const scene of picked) {
        if (scene.desktopOnly && mobile) {
            continue;
        }
        const context = await browser.newContext({
            ...layouts[layoutName],
            colorScheme,
            // 権限を渡すと渡さなかったものは許可されないことになるので、マイクも入れる
            permissions: ['microphone', 'notifications', 'clipboard-read', 'clipboard-write'],
        });
        await context.addInitScript(pageHelpers);
        const page = await context.newPage();
        try {
            let base = url;
            if (scene.cloud) {
                base = await cloudBaseUrl();
                await routeCloud(page, scene.cloud);
            }
            const target = new URL(scene.path ?? '/', base);
            target.searchParams.set('demo', '');
            await page.goto(target.toString());
            // 開発用パネルのボタンは写さない
            await page.addStyleTag({ content: '[aria-label="開発用パネル"] { display: none !important; }' });
            if (!scene.cloud || scene.cloud.me !== null) {
                await page.waitForFunction(() => window.appStore || document.body.innerText.length > 0);
            }
            // マイクボタンは、横の終了のボタンと上の経過時間も入るように広めに撮る
            const shot = async (
                name,
                { wait = 700, clip, pad = clip === micClip ? 90 : 24, fullDialog = false } = {},
            ) => {
                if (!wanted(name)) {
                    return;
                }
                // ダイアログなどのアニメーションが終わるのを待つ
                await page.waitForTimeout(wait);
                // 設定のタブなど、開いたときにフォーカスが当たった枠は写さない（文字入力中のものは残す）
                await page.evaluate(() => {
                    const el = document.activeElement;
                    if (el instanceof HTMLElement && el.getAttribute('role') === 'tab') {
                        el.blur();
                    }
                });
                const file = path.join(outDir, `${variant}-${name}.png`);
                if (fullDialog) {
                    await shootFullDialog(page, file);
                } else if (clip) {
                    const box = await clip(page).boundingBox();
                    const vp = page.viewportSize();
                    const x = Math.max(0, box.x - pad);
                    const y = Math.max(0, box.y - pad);
                    await page.screenshot({
                        path: file,
                        clip: {
                            x,
                            y,
                            width: Math.min(vp.width - x, box.width + pad * 2),
                            height: Math.min(vp.height - y, box.height + pad * 2),
                        },
                    });
                } else {
                    await page.screenshot({ path: file });
                }
                console.log(path.relative(process.cwd(), file));
            };
            await scene.open(page, { mobile, shot, all: args.all });
            if (!scene.manual) {
                await shot(scene.name, { clip: scene.clip, ...(scene.pad && { pad: scene.pad }) });
            }
        } catch (e) {
            failed++;
            console.log(`FAIL ${variant} ${scene.name}: ${e.message.split('\n')[0]}`);
            // どこで止まったか見られるよう、そのときの画面を残す
            if (process.env.SCREENSHOT_DEBUG) {
                await page
                    .screenshot({ path: path.join(outDir, `_fail-${variant}-${scene.name}.png`) })
                    .catch(() => {});
            }
        }
        await context.close();
    }
}
await browser.close();
await cloudServer?.close();
process.exit(failed ? 1 : 0);
