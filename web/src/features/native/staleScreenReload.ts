// iOS アプリ（#461。spec/mobile.md 11.7）で、サーバーが新しい版になったのに古い画面のまま使い続けないように、読み込み直す。
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
    // サーバーの版を取り直して store に入れる（GET /api/version）
    refreshServerVersion: () => Promise<void>;
    reload: () => void;
};

// 録音中（idle 以外。一時停止中も含む）
const recording = (s: AppState) => s.recordingState !== 'idle';

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

    constructor(store: AppStore, deps: StaleScreenReloaderDeps) {
        this.store = store;
        this.deps = deps;
    }

    // 見始める。返り値で見るのをやめる
    start(): () => void {
        const onVisible = () => {
            if (document.visibilityState === 'visible') {
                void this.deps.refreshServerVersion().then(() => this.check());
            }
        };
        document.addEventListener('visibilitychange', onVisible);
        // 接続したとき（serverVersion が入る）と、録音が終わったとき（待っていた読み込み直し）
        let lastVersion = this.store.getState().serverVersion;
        let lastRecording = recording(this.store.getState());
        const unsubscribe = this.store.subscribe((s) => {
            const changed = s.serverVersion !== lastVersion || recording(s) !== lastRecording;
            lastVersion = s.serverVersion;
            lastRecording = recording(s);
            if (changed) {
                this.check();
            }
        });
        this.check();
        return () => {
            document.removeEventListener('visibilitychange', onVisible);
            unsubscribe();
        };
    }

    // 版が違っていて、録音中でなく、この版のために読み込み直したことがなければ、読み込み直す。読み込み直したら true
    check(): boolean {
        const s = this.store.getState();
        const server = s.serverVersion;
        if (!server || server === this.deps.webVersion || recording(s) || readReloadedFor() === server) {
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
