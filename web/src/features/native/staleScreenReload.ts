// iOS アプリ（#461。spec/mobile.md 11.8）で、サーバーが新しい版になったのに古い画面のまま使い続けないように、読み込み直す。
// WKWebView には Service Worker がなく、ブラウザ版の「新しいバージョンの画面があります」（PwaUpdater）が出ない。
// アプリは裏に回っても WebView が生き続けるので、前面に戻ったときと接続したときに、サーバーの版と画面の版を比べる。
// @capacitor/core は読み込まない（nativeBridge から使う）
import type { AppState, AppStore } from '@/app/appState';

// 読み込み直した版を覚えるキー（sessionStorage。アプリを終えるまで残る）。
// 読み込み直しても版が違うまま（キャッシュが更新されないなど）のとき、同じ版のために何度も読み込み直さない
export const RELOADED_FOR_KEY = 'rw.native.reloadedFor';

export type StaleScreenReloaderDeps = {
    // この画面の版（webVersion）
    webVersion: string;
    // クラウド版か。クラウド版の /api/version はトンネルの先のホストの版で、画面（Workers が配る）とは別に変わるので比べない
    cloud: boolean;
    // サーバーの版を取り直して store に入れる（GET /api/version）
    refreshServerVersion: () => Promise<void>;
    reload: () => void;
    // テストで差し替える
    now?: () => number;
};

// 録音を終えてから、最後の音声と stop がサーバーに届くまで待つ長さ。ストアからは、stop を送ったかどうか
// （切れている間に止めて、つながり直してから送るもの）が見えないので、時間で待つ
export const SETTLE_MS = 10_000;

// 版が決まらないとき（git がなく unknown、コミットしていない変更で +dirty）は比べない。常に違って読み込み直しが続くため
const comparable = (v: string) => v !== 'unknown' && !v.includes('+dirty');

// 入力欄に書きかけの文字があるかもしれない
function editing(): boolean {
    const el = document.activeElement;
    return (
        el instanceof HTMLElement &&
        (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
    );
}

// 読み込み直すと途中のものを失う間か。
// 録音中（idle 以外）・参加中（joined。マイクがほかの音源として録音している）・ack 待ちの音声・アップロード中・
// 書きかけ（設定・新規プロジェクトのモーダル、選んだ音声の確認、未送信の音声の確認）
export function busy(s: AppState): boolean {
    return (
        s.recordingState !== 'idle' ||
        s.joined !== null ||
        s.pendingAudio > 0 ||
        s.uploading !== null ||
        s.pickedAudio !== null ||
        s.unsent !== null ||
        s.settingsOpen ||
        s.newProjectOpen
    );
}

function readReloadedFor(): string | null {
    try {
        return sessionStorage.getItem(RELOADED_FOR_KEY);
    } catch {
        return null;
    }
}

function writeReloadedFor(version: string) {
    try {
        sessionStorage.setItem(RELOADED_FOR_KEY, version);
    } catch {
        // 覚えられないときは、読み込み直しが続く恐れがあるので読み込み直さない（check が false を返す）
    }
}

export class StaleScreenReloader {
    private readonly store: AppStore;
    private readonly deps: StaleScreenReloaderDeps;
    // これまでは読み込み直さない時刻（録音を終えた直後）
    private settleUntil = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(store: AppStore, deps: StaleScreenReloaderDeps) {
        this.store = store;
        this.deps = deps;
    }

    private now(): number {
        return (this.deps.now ?? Date.now)();
    }

    // 見始める。返り値で見るのをやめる
    start(): () => void {
        if (this.deps.cloud) {
            return () => {};
        }
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                void this.deps.refreshServerVersion().then(() => this.check());
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        // 接続したとき（serverVersion が入る）と、待っていた理由がなくなったとき（録音・アップロードなどが終わった）
        let prev = this.store.getState();
        let endedOffline = false;
        const unsubscribe = this.store.subscribe((s) => {
            const before = prev;
            prev = s;
            if (before.recordingState !== 'idle' && s.recordingState === 'idle') {
                this.settleUntil = this.now() + SETTLE_MS;
                endedOffline = s.server.connection !== 'connected';
            }
            // 切れている間に止めたときは、つながり直してから stop を送るので、つながってからも待つ
            if (endedOffline && s.server.connection === 'connected') {
                endedOffline = false;
                this.settleUntil = this.now() + SETTLE_MS;
            }
            const connected = before.server.connection !== 'connected' && s.server.connection === 'connected';
            if (connected || s.serverVersion !== before.serverVersion || busy(before) !== busy(s)) {
                this.check();
            }
        });
        this.check();
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            unsubscribe();
            if (this.timer) {
                clearTimeout(this.timer);
            }
        };
    }

    // 版が違っていて、待つ理由がなく、この版のために読み込み直したことがなければ、読み込み直す。読み込み直したら true
    check(): boolean {
        const s = this.store.getState();
        const server = s.serverVersion;
        if (
            this.deps.cloud ||
            !server ||
            server === this.deps.webVersion ||
            !comparable(server) ||
            !comparable(this.deps.webVersion) ||
            s.server.connection !== 'connected' ||
            busy(s) ||
            editing() ||
            readReloadedFor() === server
        ) {
            return false;
        }
        const wait = this.settleUntil - this.now();
        if (wait > 0) {
            // 録音を終えた直後。落ち着いてからもう一度確かめる
            if (this.timer) {
                clearTimeout(this.timer);
            }
            this.timer = setTimeout(() => this.check(), wait);
            return false;
        }
        writeReloadedFor(server);
        if (readReloadedFor() !== server) {
            return false;
        }
        this.deps.reload();
        return true;
    }
}
