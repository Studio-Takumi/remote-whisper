// iOS アプリで、ウィジェット・App Intents から開いたときの頼みごと（#454。spec/mobile.md 11.6）。
// ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない。アプリの中では、イベントでいつもの録音の開始・セッションを開く
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { AppState, AppStore } from '@/app/appState';
import { AppEntrySync, LAST_PROJECT_KEY, READY_TIMEOUT_MS } from '@/features/native/appEntrySync';
import type { AppEntryPlugin, AppEntryRequest } from '@/features/native/appEntryTypes';

const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));
const startBridge = vi.hoisted(() => vi.fn());
// サーバーから読んだプロジェクトの一覧（キャッシュの代わり）
const projects = vi.hoisted(() => ({ ids: [] as string[], sessions: {} as Record<string, string> }));

vi.mock('@/features/native/nativeBridge', () => {
    loaded.bridge++;
    return { startAppEntry: startBridge, startLiveActivity: vi.fn(), startNativeShell: vi.fn(), Recorder: {} };
});

vi.mock('@capacitor/core', () => {
    loaded.core++;
    return {};
});

vi.mock('@/app/selectors', () => {
    const visibleProjects = () => projects.ids.map((id) => ({ id }));
    return {
        visibleProjects,
        currentProject: (s: AppState) => visibleProjects().find((p) => p.id === s.selection.projectId),
    };
});

vi.mock('@/app/sessionData', () => ({
    projectIdOf: (_s: AppState, sessionId: string) => projects.sessions[sessionId],
}));

function setCapacitor(capacitor: { isNativePlatform: () => boolean } | null) {
    const w = window as { Capacitor?: unknown };
    if (capacitor) {
        w.Capacitor = capacitor;
    } else {
        delete w.Capacitor;
    }
}

describe('startAppEntry', () => {
    beforeEach(() => {
        vi.resetModules();
        loaded.bridge = 0;
        loaded.core = 0;
        startBridge.mockClear();
    });

    afterEach(() => setCapacitor(null));

    it('ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない', async () => {
        const { startAppEntry } = await import('@/features/native/nativePlatform');
        startAppEntry({} as AppStore);
        await new Promise((r) => setTimeout(r, 0));
        expect(loaded.bridge).toBe(0);
        expect(loaded.core).toBe(0);
        expect(startBridge).not.toHaveBeenCalled();
    });

    it('アプリの中ではネイティブのコードを読み込んで始める', async () => {
        setCapacitor({ isNativePlatform: () => true });
        const store = {} as AppStore;
        const { startAppEntry } = await import('@/features/native/nativePlatform');
        startAppEntry(store);
        await vi.waitFor(() => expect(startBridge).toHaveBeenCalledWith(store));
    });
});

function makeStore(state: Partial<AppState> = {}) {
    const store = createStore<Partial<AppState>>()((set) => ({
        recordingState: 'idle',
        recordingSessionId: null,
        joined: null,
        selection: { projectId: null, sessionId: null },
        projectsLoaded: true,
        settingsLoaded: true,
        settingsOpen: false,
        startRecording: vi.fn(async () => {}),
        showRecordingSession: vi.fn(),
        newSession: vi.fn((projectId: string) => set({ selection: { projectId, sessionId: null } })),
        selectSession: vi.fn((projectId: string, sessionId: string) => set({ selection: { projectId, sessionId } })),
        setSettingsOpen: vi.fn((open: boolean) => set({ settingsOpen: open })),
        ...state,
    }));
    const get = () => store.getState() as AppState;
    return { store: store as unknown as AppStore, set: store.setState, get };
}

function makePlugin() {
    let listener: ((e: AppEntryRequest) => void) | null = null;
    const remove = vi.fn(async () => {});
    const plugin: AppEntryPlugin = {
        addListener: async (_event, fn) => {
            listener = fn;
            return { remove };
        },
    };
    const send = (request: AppEntryRequest) => listener?.(request);
    return { plugin, send, remove };
}

describe('AppEntrySync', () => {
    beforeEach(() => {
        localStorage.clear();
        projects.ids = ['p1', 'p2'];
        projects.sessions = { s1: 'p1', s2: 'p2' };
    });

    afterEach(() => vi.useRealTimers());

    it('開いたプロジェクトを覚える', () => {
        const { store, set } = makeStore();
        new AppEntrySync(store, makePlugin().plugin).start();
        expect(localStorage.getItem(LAST_PROJECT_KEY)).toBeNull();
        set({ selection: { projectId: 'p2', sessionId: 's2' } });
        expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe('p2');
        // 何も選んでいない画面に戻っても、最後に開いていたものを残す
        set({ selection: { projectId: null, sessionId: null } });
        expect(localStorage.getItem(LAST_PROJECT_KEY)).toBe('p2');
    });

    it('録音の頼みごとで、最後に開いていたプロジェクトの新規セッション画面にしていつもの録音を始める', () => {
        localStorage.setItem(LAST_PROJECT_KEY, 'p2');
        const { store, get } = makeStore();
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().newSession).toHaveBeenCalledWith('p2');
        expect(get().selection).toEqual({ projectId: 'p2', sessionId: null });
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('セッションを開いていたら、そのプロジェクトの新規セッション画面にしてから始める', () => {
        localStorage.setItem(LAST_PROJECT_KEY, 'p2');
        const { store, get } = makeStore({ selection: { projectId: 'p1', sessionId: 's1' } });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().newSession).toHaveBeenCalledWith('p1');
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('プロジェクトがないときは選ばずに、いつもの録音の開始に任せる（プロジェクトを選ぶよう出る）', () => {
        // 覚えていたプロジェクトが消えている
        localStorage.setItem(LAST_PROJECT_KEY, 'gone');
        const { store, get } = makeStore();
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().newSession).not.toHaveBeenCalled();
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('プロジェクトが 1 つもないときも、いつもの録音の開始に任せる', () => {
        projects.ids = [];
        const { store, get } = makeStore();
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().newSession).not.toHaveBeenCalled();
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('録音中なら新しく始めず、録音中のセッションを開く', () => {
        const { store, get } = makeStore({ recordingState: 'paused', recordingSessionId: 's1' });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().showRecordingSession).toHaveBeenCalledTimes(1);
        expect(get().startRecording).not.toHaveBeenCalled();
    });

    it('参加中（#241）なら新しく始めず、参加中のセッションを開く', () => {
        localStorage.setItem(LAST_PROJECT_KEY, 'p1');
        const { store, get } = makeStore({ joined: { sessionId: 's2', source: 2, state: 'joined' } });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().startRecording).not.toHaveBeenCalled();
        expect(get().newSession).not.toHaveBeenCalled();
        expect(get().selectSession).toHaveBeenCalledWith('p2', 's2');
    });

    it('設定モーダルを開いていたら閉じてから始める', () => {
        localStorage.setItem(LAST_PROJECT_KEY, 'p1');
        const { store, get } = makeStore({ settingsOpen: true });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().setSettingsOpen).toHaveBeenCalledWith(false);
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('プロジェクトの一覧と設定を読み込むまで待ってから始める', () => {
        localStorage.setItem(LAST_PROJECT_KEY, 'p1');
        const { store, set, get } = makeStore({ projectsLoaded: false, settingsLoaded: false });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        expect(get().startRecording).not.toHaveBeenCalled();
        set({ projectsLoaded: true });
        expect(get().startRecording).not.toHaveBeenCalled();
        set({ settingsLoaded: true });
        expect(get().newSession).toHaveBeenCalledWith('p1');
        expect(get().startRecording).toHaveBeenCalledTimes(1);
        // 一度だけ
        set({ elapsed: 1 });
        expect(get().startRecording).toHaveBeenCalledTimes(1);
    });

    it('読み込めないまま時間が過ぎたら、頼みごとを捨てる', () => {
        vi.useFakeTimers();
        const { store, set, get } = makeStore({ projectsLoaded: false });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        vi.advanceTimersByTime(READY_TIMEOUT_MS);
        set({ projectsLoaded: true });
        expect(get().startRecording).not.toHaveBeenCalled();
    });

    it('待っている間に届いたものは、後のものだけ通す', () => {
        const { store, set, get } = makeStore({ projectsLoaded: false });
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'record' });
        send({ kind: 'session', sessionId: 's2' });
        set({ projectsLoaded: true });
        expect(get().startRecording).not.toHaveBeenCalled();
        expect(get().selectSession).toHaveBeenCalledWith('p2', 's2');
    });

    it('セッションの頼みごとで、そのセッションを開く。録音中のものなら録音中のセッションを開く', () => {
        const { store, set, get } = makeStore();
        const { plugin, send } = makePlugin();
        new AppEntrySync(store, plugin).start();
        send({ kind: 'session', sessionId: 's2' });
        expect(get().selectSession).toHaveBeenCalledWith('p2', 's2');
        set({ recordingState: 'recording', recordingSessionId: 's1' });
        send({ kind: 'session', sessionId: 's1' });
        expect(get().showRecordingSession).toHaveBeenCalledTimes(1);
        // 知らないセッションでは何もしない
        send({ kind: 'session', sessionId: 'unknown' });
        expect(get().selectSession).toHaveBeenCalledTimes(1);
    });

    it('やめたら聞くのをやめる', async () => {
        const { store } = makeStore();
        const { plugin, remove } = makePlugin();
        const stop = new AppEntrySync(store, plugin).start();
        stop();
        await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    });
});
