// 録音中、文字起こし中の行（partial）が上下に揺れないかを測る（#89）
//
// 準備: cd web && npm run dev（サーバーは要らない。?demo のダミーのセッションに、partial と final を直接流し込む）
// 測る: cd web && node scripts/partial-jitter.mjs
//
// 環境変数:
//   JITTER_URL     画面の URL（既定: http://localhost:5173）
//   CHROMIUM_PATH  使う Chromium の実行ファイル（省略すると Playwright のもの）
//   JITTER_EMPTY_FINAL=1  捨てられた区間でも空の final が届くとして流す（届かないと partial が残る）
//   JITTER_VERBOSE=1      上に戻ったときの前後のフレーム（位置 y・ページの高さ h）を出す
//
// 一番下を見ている状態で、サーバーが送るような partial（未確定部分が伸び縮みする）と final を流し、
// 1 フレームごとにスクロールの位置を記録する。こちらからはスクロールしないので、位置が上に戻ったら揺れている
import { chromium } from 'playwright';

const url = process.env.JITTER_URL ?? 'http://localhost:5173';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const layouts = {
    desktop: { viewport: { width: 1280, height: 800 } },
    mobile: { viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true },
};

for (const [name, options] of Object.entries(layouts)) {
    const page = await browser.newPage(options);
    await page.goto(`${url}/?demo`);
    if (name === 'mobile') {
        await page.getByLabel('メニューを開く').click();
    }
    await page.getByText('新機能のリリース計画', { exact: true }).click();
    const emptyFinal = process.env.JITTER_EMPTY_FINAL === '1';
    const result = await page.evaluate(run, { emptyFinal, reading: false });
    console.log(
        `${name}: 上に戻った ${result.upMoves} 回（計 ${result.upPx}px）、` +
            `一番下から離れた ${result.leftBottom} フレーム / ${result.frames} フレーム`,
    );
    if (process.env.JITTER_VERBOSE === '1') {
        for (const s of result.samples) {
            console.log('  ', JSON.stringify(s));
        }
    }
    // 上のほうを読んでいるときは、勝手にスクロールしない（#78）
    const reading = await page.evaluate(run, { emptyFinal, reading: true });
    console.log(`${name}（上のほうを読んでいる）: 位置が動いた ${reading.moved} フレーム / ${reading.frames} フレーム`);
    await page.close();
}
await browser.close();

// ページの中で動かす。emptyFinal は、捨てられた区間でも空の final が届く（partial が消える）かどうか。
// reading は、一番下ではなく上のほうを見ている状態で流すかどうか
async function run({ emptyFinal, reading }) {
    const store = window.appStore;
    const sid = store.getState().selection.sessionId;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const updateTranscript = (f) =>
        store.setState((s) => ({
            projects: s.projects.map((p) => ({
                ...p,
                sessions: p.sessions.map((x) => (x.id === sid ? { ...x, transcript: f(x.transcript) } : x)),
            })),
        }));
    const line = (i) => ({
        time: `00:${String(10 + i).padStart(2, '0')}:00`,
        text: `これは ${i} 行目の確定した文字起こしです。画面がスクロールするように行を増やしています。`,
    });

    // スクロールできる長さにして、一番下へ（reading なら上のほうへ）
    updateTranscript((t) => [...t, ...Array.from({ length: 30 }, (_, i) => line(i))]);
    await sleep(300);
    window.scrollTo(0, reading ? 300 : document.documentElement.scrollHeight);
    await sleep(300);

    // 1 フレームごとに記録する
    const frames = [];
    let recording = true;
    const tick = () => {
        const el = document.documentElement;
        frames.push({
            y: window.scrollY,
            h: el.scrollHeight,
            bottom: el.scrollHeight - window.scrollY - el.clientHeight,
        });
        if (recording) {
            requestAnimationFrame(tick);
        }
    };
    requestAnimationFrame(tick);

    // サーバーが送るような流れ: 区間ごとに partial を 0.3 秒おきに送り、final で置き換える。
    // 未確定部分は、書き換わるたびに長くなったり短くなったりする（行数が変わる）。
    // 3 つに 1 つの区間は、ハルシネーションとして捨てられて final が来ない
    const words = '今日はリリース計画について決めていきたいと思いますまずステージング環境での確認ですが';
    for (let segment = 0; segment < 6; segment++) {
        let committed = '';
        for (let step = 0; step < 10; step++) {
            committed = words.slice(0, Math.min(words.length, step * 4));
            const tentative = step % 2 ? '少し' : words.repeat(2).slice(step, step + 60);
            store.setState({ partial: { sessionId: sid, segment, committed, tentative } });
            await sleep(300);
        }
        if (segment % 3 !== 2) {
            updateTranscript((t) => [...t, { time: '00:59:00', text: committed + '。' }]);
            store.setState({ partial: null });
        } else if (emptyFinal) {
            store.setState({ partial: null });
        }
        await sleep(300);
    }
    await sleep(500);
    recording = false;

    let upMoves = 0;
    let upPx = 0;
    const samples = [];
    for (let i = 1; i < frames.length; i++) {
        const d = frames[i].y - frames[i - 1].y;
        if (d < 0) {
            upMoves++;
            upPx -= d;
            // 前後のフレーム（位置・ページの高さ）
            samples.push(frames.slice(Math.max(0, i - 2), i + 2));
        }
    }
    // 一番下（下のマイクのボタンの分の余白 160px 以内）から離れていたフレーム
    const leftBottom = frames.filter((f) => f.bottom > 160).length;
    const moved = frames.filter((f) => f.y !== frames[0].y).length;
    return { upMoves, upPx, leftBottom, moved, frames: frames.length, samples: samples.slice(0, 3) };
}
