// iOS アプリで、ウィジェット・App Intents から開いたときの頼みごと（#454。spec/mobile.md 11.6）を、いつもの操作に渡す。
// 録音は web/ のまま。ここはプラグインのイベントを受けて、マイクボタンと同じ録音の開始・セッションを開く処理を呼ぶだけ。
// ネイティブのプラグインは nativeBridge が渡す（このファイルは @capacitor/core を読み込まない）
import type { AppState, AppStore } from '@/app/appState';
import { currentProject, visibleProjects } from '@/app/selectors';
import { projectIdOf } from '@/app/sessionData';
import type { AppEntryPlugin, AppEntryRequest } from '@/features/native/appEntryTypes';

// 最後に開いていたプロジェクト（アプリの中だけ。端末ごとの覚え書きなので localStorage）
export const LAST_PROJECT_KEY = 'rw.ios.lastProject';
// プロジェクトの一覧と設定を読めるまで待つ長さ。過ぎたら頼みごとは捨てる（つながってから急に録音が始まらないように）
export const READY_TIMEOUT_MS = 30_000;

const ready = (s: AppState) => s.projectsLoaded && s.settingsLoaded;

function readLastProject(): string | null {
    try {
        return localStorage.getItem(LAST_PROJECT_KEY);
    } catch {
        return null;
    }
}

function writeLastProject(id: string) {
    try {
        localStorage.setItem(LAST_PROJECT_KEY, id);
    } catch {
        // 覚えられなくても、開いているプロジェクトがあればそこで始める
    }
}

// 録音を始めるプロジェクト。開いているもの → 最後に開いていたもの（今もあれば）
export function recordingProjectId(s: AppState): string | null {
    const current = currentProject(s);
    if (current) {
        return current.id;
    }
    const last = readLastProject();
    return last && visibleProjects(s).some((p) => p.id === last) ? last : null;
}

export class AppEntrySync {
    // 読み込みを待っている頼みごと（後から届いたものだけ残す）
    private pending: AppEntryRequest | null = null;
    private stopWaiting: (() => void) | null = null;

    private readonly store: AppStore;
    private readonly plugin: AppEntryPlugin;

    constructor(store: AppStore, plugin: AppEntryPlugin) {
        this.store = store;
        this.plugin = plugin;
    }

    // 見始める。返り値で見るのをやめる
    start(): () => void {
        let lastProject: string | null = null;
        const remember = (s: AppState) => {
            const id = s.selection.projectId;
            if (id && id !== lastProject) {
                lastProject = id;
                writeLastProject(id);
            }
        };
        remember(this.store.getState());
        const unsubscribe = this.store.subscribe(remember);
        const listening = this.plugin.addListener('entry', (request) => this.onEntry(request));
        return () => {
            unsubscribe();
            this.stopWaiting?.();
            void listening.then((h) => h.remove()).catch(() => {});
        };
    }

    private onEntry(request: AppEntryRequest) {
        if (ready(this.store.getState())) {
            this.handle(request);
            return;
        }
        // アプリを開いた直後は、プロジェクトの一覧と設定を読み込むまで待つ
        this.pending = request;
        if (this.stopWaiting) {
            return;
        }
        const timer = setTimeout(() => this.finishWaiting(), READY_TIMEOUT_MS);
        const unsubscribe = this.store.subscribe((s) => {
            if (ready(s)) {
                const next = this.pending;
                this.finishWaiting();
                if (next) {
                    this.handle(next);
                }
            }
        });
        this.stopWaiting = () => {
            clearTimeout(timer);
            unsubscribe();
        };
    }

    private finishWaiting() {
        this.stopWaiting?.();
        this.stopWaiting = null;
        this.pending = null;
    }

    private handle(request: AppEntryRequest) {
        if (request.kind === 'record') {
            this.record();
        } else {
            this.openSession(request.sessionId);
        }
    }

    // マイクボタンと同じいつもの録音の開始。録音中なら、録音中のセッションを開くだけ
    private record() {
        const s = this.store.getState();
        if (s.settingsOpen) {
            s.setSettingsOpen(false);
        }
        if (s.recordingState !== 'idle') {
            s.showRecordingSession();
            return;
        }
        // 参加中（#241）も、もう一つマイクを開いて録音を始めないよう、参加中のセッションを開くだけにする
        if (s.joined) {
            this.openSession(s.joined.sessionId);
            return;
        }
        const projectId = recordingProjectId(s);
        if (projectId) {
            // 新規セッション画面にしてから始める（セッションを開いたままだと、新規セッション画面に切り替えるだけになる）
            s.newSession(projectId);
        }
        // プロジェクトがなければ、いつもの「録音するプロジェクトをメニューから選んでください」が出る
        void this.store.getState().startRecording();
    }

    private openSession(sessionId: string) {
        const s = this.store.getState();
        if (s.recordingSessionId === sessionId) {
            s.showRecordingSession();
            return;
        }
        const projectId = projectIdOf(s, sessionId);
        if (projectId) {
            s.selectSession(projectId, sessionId);
        }
    }
}
