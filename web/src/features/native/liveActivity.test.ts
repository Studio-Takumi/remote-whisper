// iOS アプリの Live Activity（#453。spec/mobile.md 11.5）。ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない。
// アプリの中では、録音の状態に合わせて start・update・end を呼び、ボタンの操作をいつもの一時停止・再開・終了に渡す
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { Session } from '@/api/types';
import type { AppState, AppStore } from '@/app/appState';
import { LINE_UPDATE_INTERVAL_MS, LiveActivitySync, RETRY_INTERVAL_MS } from '@/features/native/liveActivitySync';
import type { LiveActivityAction, LiveActivityPlugin } from '@/features/native/liveActivityTypes';

const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));
const startBridge = vi.hoisted(() => vi.fn());

vi.mock('@/features/native/nativeBridge', () => {
    loaded.bridge++;
    return { startLiveActivity: startBridge, startNativeShell: vi.fn() };
});

vi.mock('@capacitor/core', () => {
    loaded.core++;
    return {};
});

function setCapacitor(capacitor: { isNativePlatform: () => boolean } | null) {
    const w = window as { Capacitor?: unknown };
    if (capacitor) {
        w.Capacitor = capacitor;
    } else {
        delete w.Capacitor;
    }
}

describe('startLiveActivity', () => {
    beforeEach(() => {
        vi.resetModules();
        loaded.bridge = 0;
        loaded.core = 0;
        startBridge.mockClear();
    });

    afterEach(() => setCapacitor(null));

    it('ブラウザでは何もせず、ネイティブを呼ぶコードも読み込まない', async () => {
        const { startLiveActivity } = await import('@/features/native/nativePlatform');
        startLiveActivity({} as AppStore);
        await new Promise((r) => setTimeout(r, 0));
        expect(loaded.bridge).toBe(0);
        expect(loaded.core).toBe(0);
        expect(startBridge).not.toHaveBeenCalled();
    });

    it('アプリの中ではネイティブのコードを読み込んで始める', async () => {
        setCapacitor({ isNativePlatform: () => true });
        const store = {} as AppStore;
        const { startLiveActivity } = await import('@/features/native/nativePlatform');
        startLiveActivity(store);
        await vi.waitFor(() => expect(startBridge).toHaveBeenCalledWith(store));
    });
});

const line = (text: string) => ({ time: '00:00:00', text });

function session(transcript: string[], title = '情報理論 第8回'): Session {
    return {
        id: 's1',
        title,
        startedAt: '2026-11-20 10:00:00',
        status: 'recording',
        transcript: transcript.map(line),
        summaries: [],
    };
}

function makeStore() {
    const actions = {
        pauseRecording: vi.fn(async () => {}),
        resumeRecording: vi.fn(),
        stopRecording: vi.fn(async () => {}),
    };
    const store = createStore<Partial<AppState>>()(() => ({
        recordingState: 'idle',
        recordingSessionId: null,
        elapsed: 0,
        micState: 'ok',
        localSessions: [],
        ...actions,
    }));
    return { store: store as unknown as AppStore, set: store.setState, actions };
}

function makePlugin() {
    const calls: unknown[][] = [];
    let listener: ((e: { action: LiveActivityAction }) => void) | null = null;
    const remove = vi.fn(async () => {});
    const plugin: LiveActivityPlugin = {
        start: async (o) => {
            calls.push(['start', o]);
            return { shown: true };
        },
        update: async (o) => {
            calls.push(['update', o]);
            return { shown: true };
        },
        end: async () => {
            calls.push(['end']);
        },
        addListener: async (_event, fn) => {
            listener = fn;
            return { remove };
        },
    };
    const press = (action: LiveActivityAction) => listener?.({ action });
    return { plugin, calls, press, remove };
}

// プラグインの呼び出しは Promise でつないでいるので、届くまで待つ
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('LiveActivitySync', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('始めたときに、前に出したものを片付ける', async () => {
        const { store } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        await flush();
        expect(calls).toEqual([['end']]);
    });

    it('録音を始めたら start、止めたら end', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            elapsed: 3,
            localSessions: [{ projectId: 'p', session: session(['a', 'b', 'c', 'd']) }],
        });
        set({ recordingState: 'idle', recordingSessionId: null });
        await flush();
        expect(calls).toEqual([
            ['end'],
            [
                'start',
                {
                    sessionId: 's1',
                    state: 'recording',
                    elapsed: 3,
                    title: '情報理論 第8回',
                    lines: ['a', 'b', 'c', 'd'],
                },
            ],
            ['end'],
        ]);
    });

    it('録音中のセッションが変わったら start し直す', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({ recordingState: 'recording', recordingSessionId: 's1' });
        set({ recordingSessionId: 's2', elapsed: 5 });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'start']);
        expect(calls[2][1]).toMatchObject({ sessionId: 's2', elapsed: 5 });
    });

    it('マイクが止まった・戻ったときも update して経過時間を合わせ直す', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({ recordingState: 'recording', recordingSessionId: 's1', elapsed: 10 });
        set({ micState: 'suspended', elapsed: 12 });
        set({ micState: 'ok', elapsed: 12 });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'update', 'update']);
        expect(calls[2][1]).toMatchObject({ state: 'recording', elapsed: 12 });
    });

    it('出せなかったら覚えず、経過時間のほかが変わったときに start し直す', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        let shown = false;
        vi.spyOn(console, 'info').mockImplementation(() => {});
        plugin.start = async (o) => {
            calls.push(['start', o]);
            return { shown };
        };
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session(['a']) }],
        });
        await flush();
        // 経過時間だけでは出し直さない
        set({ elapsed: 1 });
        set({ elapsed: 2 });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start']);
        // 録音中に設定で許可された。次に行が変わったときに出る
        shown = true;
        await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS);
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b']) }] });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'start']);
        expect(calls[2][1]).toMatchObject({ lines: ['a', 'b'], elapsed: 2 });
        // 出せたあとは今までどおり
        set({ recordingState: 'paused' });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'start', 'update']);
    });

    it('出せないまま行だけ変わるときは、前回の start から 60 秒たつまで出し直さない', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        plugin.start = async (o) => {
            calls.push(['start', o]);
            return { shown: false, reason: 'not-allowed' };
        };
        vi.spyOn(console, 'info').mockImplementation(() => {});
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session(['a']) }],
        });
        await flush();
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b']) }] });
        await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS - 1000);
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b', 'c']) }] });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start']);
        await vi.advanceTimersByTimeAsync(1000);
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b', 'c', 'd']) }] });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'start']);
    });

    it('start が失敗したら、次の状態の変化で start し直す', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        let fail = true;
        const start = plugin.start;
        plugin.start = async (o) => {
            if (fail) {
                calls.push(['start-failed']);
                throw new Error('unavailable');
            }
            return start(o);
        };
        new LiveActivitySync(store, plugin).start();
        set({ recordingState: 'recording', recordingSessionId: 's1' });
        await flush();
        fail = false;
        set({ recordingState: 'paused' });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start-failed', 'start']);
        expect(calls[2][1]).toMatchObject({ state: 'paused' });
    });

    describe('出せなかった理由のログ（#462）', () => {
        let info: ReturnType<typeof vi.spyOn>;
        let warn: ReturnType<typeof vi.spyOn>;
        beforeEach(() => {
            info = vi.spyOn(console, 'info').mockImplementation(() => {});
            warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        });
        afterEach(() => {
            info.mockRestore();
            warn.mockRestore();
        });

        it('start が shown: false のとき、理由を [LiveActivity] で出す', async () => {
            const { store, set } = makeStore();
            const { plugin } = makePlugin();
            plugin.start = async () => ({ shown: false, reason: 'request-failed', message: 'too many activities' });
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            await flush();
            expect(info).toHaveBeenCalledWith('[LiveActivity] not shown: request-failed (too many activities)');
        });

        it('出せないまま行が変わっても、同じ理由は 1 セッションに 1 回だけ出す', async () => {
            const { store, set } = makeStore();
            const { plugin, calls } = makePlugin();
            plugin.start = async (o) => {
                calls.push(['start', o]);
                return { shown: false, reason: 'not-allowed' };
            };
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            await flush();
            // 状態が変わるたびに start し直すが、ログは増えない
            set({ recordingState: 'paused' });
            await flush();
            set({ recordingState: 'recording' });
            await flush();
            expect(calls.filter((c) => c[0] === 'start')).toHaveLength(3);
            expect(info).toHaveBeenCalledTimes(1);
            // 別のセッションでは、もう一度出す
            set({ recordingSessionId: 's2' });
            await flush();
            expect(info).toHaveBeenCalledTimes(2);
        });

        it('理由が変わったときは出す', async () => {
            const { store, set } = makeStore();
            const { plugin } = makePlugin();
            let reason: 'not-allowed' | 'request-failed' = 'not-allowed';
            plugin.start = async () => ({ shown: false, reason });
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            await flush();
            reason = 'request-failed';
            set({ recordingState: 'paused' });
            await flush();
            expect(info).toHaveBeenCalledTimes(2);
        });

        it('理由が付いていなくても（古いネイティブ）出す', async () => {
            const { store, set } = makeStore();
            const { plugin } = makePlugin();
            plugin.start = async () => ({ shown: false });
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            await flush();
            expect(info).toHaveBeenCalledWith('[LiveActivity] not shown: unknown');
        });

        it('プラグインが reject したとき、呼び出しの名前と理由を出す', async () => {
            const { store, set } = makeStore();
            const { plugin } = makePlugin();
            plugin.start = async () => {
                throw new Error('unavailable');
            };
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            await flush();
            expect(warn).toHaveBeenCalledWith('[LiveActivity] start failed: unavailable');
        });

        it('出せたときと毎回の update では何も出さない', async () => {
            const { store, set } = makeStore();
            const { plugin } = makePlugin();
            new LiveActivitySync(store, plugin).start();
            set({ recordingState: 'recording', recordingSessionId: 's1' });
            set({ recordingState: 'paused' });
            set({ recordingState: 'recording' });
            await flush();
            expect(info).not.toHaveBeenCalled();
            expect(warn).not.toHaveBeenCalled();
        });
    });

    it('一時停止・再開はすぐ update し、経過時間だけの変化では送らない', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session([]) }],
        });
        set({ elapsed: 1 });
        set({ elapsed: 2 });
        set({ recordingState: 'paused' });
        set({ recordingState: 'recording', elapsed: 2 });
        await flush();
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'update', 'update']);
        expect(calls[2][1]).toMatchObject({ state: 'paused', elapsed: 2 });
        expect(calls[3][1]).toMatchObject({ state: 'recording', elapsed: 2 });
    });

    it('文字起こしの行は間引いて、まとめて最新のものを送る', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session(['a']) }],
        });
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b']) }] });
        await vi.advanceTimersByTimeAsync(1000);
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b', 'c'], '仮のタイトル') }] });
        await vi.advanceTimersByTimeAsync(LINE_UPDATE_INTERVAL_MS - 1001);
        expect(calls.map((c) => c[0])).toEqual(['end', 'start']);
        await vi.advanceTimersByTimeAsync(1);
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'update']);
        expect(calls[2][1]).toMatchObject({ lines: ['a', 'b', 'c'], title: '仮のタイトル' });
    });

    it('文字起こしは、新しいほうから最大 12 区切りを送る（つなげて折り返すのは Swift）', async () => {
        const all = Array.from({ length: 15 }, (_, i) => `s${i}`);
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session(all) }],
        });
        await flush();
        const start = calls.find((c) => c[0] === 'start');
        expect((start?.[1] as { lines: string[] }).lines).toEqual(all.slice(-12));
    });

    it('止めたら、待っていた行の更新は送らない', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        set({
            recordingState: 'recording',
            recordingSessionId: 's1',
            localSessions: [{ projectId: 'p', session: session(['a']) }],
        });
        set({ localSessions: [{ projectId: 'p', session: session(['a', 'b']) }] });
        set({ recordingState: 'idle', recordingSessionId: null });
        await vi.advanceTimersByTimeAsync(LINE_UPDATE_INTERVAL_MS * 2);
        expect(calls.map((c) => c[0])).toEqual(['end', 'start', 'end']);
    });

    it('ボタンの操作で、いつもの一時停止・再開・終了を呼ぶ', async () => {
        const { store, set, actions } = makeStore();
        const { plugin, press } = makePlugin();
        new LiveActivitySync(store, plugin).start();
        await flush();
        // 録音していなければ何もしない
        press('pause');
        press('stop');
        expect(actions.pauseRecording).not.toHaveBeenCalled();
        expect(actions.stopRecording).not.toHaveBeenCalled();

        set({ recordingState: 'recording', recordingSessionId: 's1' });
        press('resume');
        expect(actions.resumeRecording).not.toHaveBeenCalled();
        press('pause');
        expect(actions.pauseRecording).toHaveBeenCalledTimes(1);

        set({ recordingState: 'paused' });
        press('pause');
        expect(actions.pauseRecording).toHaveBeenCalledTimes(1);
        press('resume');
        expect(actions.resumeRecording).toHaveBeenCalledTimes(1);
        press('stop');
        expect(actions.stopRecording).toHaveBeenCalledTimes(1);
    });

    it('やめたら、ストアの購読とボタンの受け取りを外す', async () => {
        const { store, set } = makeStore();
        const { plugin, calls, remove } = makePlugin();
        const stop = new LiveActivitySync(store, plugin).start();
        await flush();
        stop();
        await flush();
        set({ recordingState: 'recording', recordingSessionId: 's1' });
        await flush();
        expect(calls).toEqual([['end']]);
        expect(remove).toHaveBeenCalled();
    });

    it('プラグインが失敗しても、そのあとの呼び出しは続ける', async () => {
        const { store, set } = makeStore();
        const { plugin, calls } = makePlugin();
        plugin.start = async () => {
            throw new Error('unavailable');
        };
        new LiveActivitySync(store, plugin).start();
        set({ recordingState: 'recording', recordingSessionId: 's1' });
        set({ recordingState: 'idle', recordingSessionId: null });
        await flush();
        expect(calls).toEqual([['end'], ['end']]);
    });
});
