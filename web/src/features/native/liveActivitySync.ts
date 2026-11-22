// iOS アプリの中で、録音の状態をロック画面の Live Activity とダイナミックアイランドに出す（#453。spec/mobile.md 11.5）。
// 録音は web/ のまま。ここはストアを見てプラグインを呼ぶのと、ボタンの操作をいつもの一時停止・再開・終了に渡すだけ。
// ネイティブのプラグインは nativeBridge が渡す（このファイルは @capacitor/core を読み込まない）
import type { AppState, AppStore } from '@/app/appState';
import type { LiveActivityAction, LiveActivityContent, LiveActivityPlugin } from '@/features/native/liveActivityTypes';
import { findLocal } from '@/features/projects/localSessions';
import type { MicState } from '@/features/recording/audio/microphone';

// 送る文字起こしの区切りの数。つなげて 3 行に折り返すのは Swift（iOS アプリ）がする。
// 区切りが短いときも 3 行が埋まるよう、多めに送る（Swift が、新しいほうから約 120 文字ぶんだけ持つ）
const LINES = 12;
// 文字起こしの行の更新は、これより短い間隔では送らない（ActivityKit の更新の頻度の制限）
export const LINE_UPDATE_INTERVAL_MS = 5000;

// mic はプラグインには送らない。マイクが止まった・戻ったときに経過時間を合わせ直すために見る（#447）
export type LiveActivitySnapshot = LiveActivityContent & { sessionId: string; mic: MicState };

// 録音していなければ null
export function snapshotOf(s: AppState): LiveActivitySnapshot | null {
    if (s.recordingState === 'idle' || !s.recordingSessionId) {
        return null;
    }
    const session = findLocal(s.localSessions, s.recordingSessionId)?.session;
    return {
        sessionId: s.recordingSessionId,
        state: s.recordingState,
        elapsed: s.elapsed,
        title: session?.title ?? '',
        lines: (session?.transcript ?? []).slice(-LINES).map((x) => x.text),
        mic: s.micState,
    };
}

const sameLines = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function content(s: LiveActivitySnapshot): LiveActivityContent {
    return { state: s.state, elapsed: s.elapsed, title: s.title, lines: s.lines };
}

// 最後に送ったもの。shown は出せたか（null は start の返事待ち。false は許可されていない・出せなかった）
type Sent = { snapshot: LiveActivitySnapshot; shown: boolean | null };

export class LiveActivitySync {
    // 録音していなければ null
    private sent: Sent | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    // プラグインは呼んだ順に流す（start の前に update が届かないように）
    private queue: Promise<unknown> = Promise.resolve();

    private readonly store: AppStore;
    private readonly plugin: LiveActivityPlugin;

    constructor(store: AppStore, plugin: LiveActivityPlugin) {
        this.store = store;
        this.plugin = plugin;
    }

    // 見始める。返り値で見るのをやめる
    start(): () => void {
        // 前に読み込んだ画面が出したもの（読み込み直す前の録音）を残さない
        this.call('end', () => this.plugin.end());
        const listening = this.plugin.addListener('action', ({ action }) => this.onAction(action));
        const unsubscribe = this.store.subscribe((s) => this.onChange(snapshotOf(s)));
        this.onChange(snapshotOf(this.store.getState()));
        return () => {
            unsubscribe();
            this.clearTimer();
            void listening.then((h) => h.remove()).catch(() => {});
        };
    }

    private onChange(next: LiveActivitySnapshot | null) {
        const sent = this.sent;
        if (!next) {
            if (sent) {
                this.sent = null;
                this.clearTimer();
                this.call('end', () => this.plugin.end());
            }
            return;
        }
        if (!sent || sent.snapshot.sessionId !== next.sessionId) {
            this.startActivity(next);
            return;
        }
        const prev = sent.snapshot;
        const linesChanged = !sameLines(prev.lines, next.lines) || prev.title !== next.title;
        if (sent.shown === false) {
            // 出せなかった（設定で許可されていないなど）。録音中に許可されたときのため、経過時間のほかが変わったら出し直す
            if (prev.state !== next.state || prev.mic !== next.mic || linesChanged) {
                this.startActivity(next);
            }
            return;
        }
        if (prev.state !== next.state || prev.mic !== next.mic) {
            // 一時停止・再開はすぐ出す。マイクが止まった・戻ったとき（#447）も、経過時間をここで合わせ直す
            this.updateActivity(next);
            return;
        }
        // 経過時間は端末が数えるので、変わっても送らない。行とタイトルは間引いて送る
        if (linesChanged && !this.timer) {
            this.timer = setTimeout(() => {
                this.timer = null;
                const latest = snapshotOf(this.store.getState());
                if (latest && this.sent?.snapshot.sessionId === latest.sessionId) {
                    this.updateActivity(latest);
                }
            }, LINE_UPDATE_INTERVAL_MS);
        }
    }

    private startActivity(next: LiveActivitySnapshot) {
        const sent: Sent = { snapshot: next, shown: null };
        this.sent = sent;
        this.clearTimer();
        // 返事が来るまでの間の変化は update で送る（出せていなければネイティブ側が何もしない）
        const done = (shown: boolean) => {
            if (this.sent === sent) {
                sent.shown = shown;
            }
        };
        this.call('start', () =>
            this.plugin.start({ sessionId: next.sessionId, ...content(next) }).then(
                (r) => {
                    done(r.shown);
                    if (!r.shown) {
                        // 出せなかった理由。start の結果だけ出す（毎回の update では出さない）
                        const detail = r.message ? ` (${r.message})` : '';
                        console.info(`[LiveActivity] not shown: ${r.reason ?? 'unknown'}${detail}`);
                    }
                },
                (e: unknown) => {
                    done(false);
                    throw e;
                },
            ),
        );
    }

    private updateActivity(next: LiveActivitySnapshot) {
        if (this.sent) {
            this.sent.snapshot = next;
        }
        this.clearTimer();
        this.call('update', () => this.plugin.update(content(next)));
    }

    // Live Activity が出せなくても録音には関わらないので、失敗は理由だけ出して続ける
    private call(name: string, fn: () => Promise<unknown>) {
        this.queue = this.queue.then(fn).catch((e: unknown) => {
            console.warn(`[LiveActivity] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
        });
    }

    private clearTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    // ボタンの操作は、マイクボタンと同じいつもの処理に渡す。今の状態で押せないもの（届くのが遅れたなど）は何もしない
    private onAction(action: LiveActivityAction) {
        const s = this.store.getState();
        if (action === 'pause' && s.recordingState === 'recording') {
            void s.pauseRecording();
        } else if (action === 'resume' && s.recordingState === 'paused') {
            s.resumeRecording();
        } else if (action === 'stop' && s.recordingState !== 'idle') {
            void s.stopRecording();
        }
    }
}
