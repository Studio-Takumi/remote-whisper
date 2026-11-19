import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@/api/protocol';
import type { Project } from '@/api/types';
import type { useAppStore as Store } from '@/app/store';
import type { UnsentSession } from '@/features/recording/audio/unsentStore';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects } from '@/test/seedProjects';

// 録音していたページが閉じられたセッションを、つなぎ直すのを待たずに終わりにする（#448。spec/flows.md 6.7）
const SESSION = '2026-11-20_10-00-00';
const KEY = 'rw.recordingSessions';
const LOCK = `rw.recording:${SESSION}`;

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;
let toasts: { error: ReturnType<typeof vi.fn> };

// Web Locks の偽物。held はロックを持っているページ（このページのものも、ほかのタブのものも）
function fakeLocks(heldElsewhere: string[] = []) {
    const held = new Set(heldElsewhere);
    const locks = {
        held,
        request: (name: string, callback: () => Promise<void>) => {
            held.add(name);
            return callback().then(() => {
                held.delete(name);
            });
        },
        query: async () => ({ held: [...held].map((name) => ({ name })) }),
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
    return locks;
}

function frame(seq: number, samples: number) {
    const buffer = new ArrayBuffer(4 + samples * 2);
    new DataView(buffer).setUint32(0, seq, true);
    return { seq, frame: buffer };
}

const projects: Project[] = [
    {
        id: 'p1',
        name: 'p1',
        path: '/p1',
        sessions: [
            {
                id: SESSION,
                title: '講義',
                startedAt: '2026-11-20 10:00',
                status: 'recording',
                transcript: [],
                summaries: [],
            },
        ],
    },
];

async function setup(unsent: UnsentSession[] = []) {
    vi.resetModules();
    vi.doMock('@/features/recording/audio/unsentStore', async (importOriginal) => ({
        ...(await importOriginal<object>()),
        listUnsent: async () => unsent,
        saveChunk: async () => true,
        deleteUpTo: async () => {},
        clearSession: async () => {
            unsent.length = 0;
        },
        restoreSize: () => {},
    }));
    toasts = { error: vi.fn() };
    vi.doMock('sonner', () => ({
        toast: Object.assign(vi.fn(), { error: toasts.error, warning: vi.fn(), info: vi.fn(), success: vi.fn() }),
    }));
    const { connection } = await import('@/api/connection');
    const { Microphone } = await import('@/features/recording/audio/microphone');
    ws = fakeConnection(connection);
    vi.spyOn(connection, 'isOpen', 'get').mockImplementation(() => ws.connected);
    mic = fakeMicrophone(Microphone);
    ({ useAppStore: store } = await import('@/app/store'));
    await seedProjects(store, projects);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
}

function receive(message: ServerMessage) {
    ws.receive(message);
}

function marks() {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as { session: string; host: string | null }[];
}

function remember(session = SESSION) {
    localStorage.setItem(KEY, JSON.stringify([{ session, host: null }]));
}

async function startRecording() {
    store.setState({ selection: { projectId: 'p1', sessionId: null } });
    const starting = store.getState().startRecording();
    await vi.waitFor(() => expect(ws.log()).toContain('start'));
    receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
    await starting;
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    localStorage.clear();
});

afterEach(() => {
    vi.doUnmock('@/features/recording/audio/unsentStore');
    vi.doUnmock('sonner');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.deleteProperty(navigator, 'locks');
});

describe('録音していたページが閉じられたセッション', () => {
    it('録音している間は端末に覚えてロックを持ち、終えたら忘れる', async () => {
        const locks = fakeLocks();
        await setup();
        await startRecording();
        expect(marks()).toEqual([{ session: SESSION, host: null }]);
        await vi.waitFor(() => expect(locks.held.has(LOCK)).toBe(true));

        await store.getState().stopRecording();
        expect(marks()).toEqual([]);
        await vi.waitFor(() => expect(locks.held.has(LOCK)).toBe(false));
    });

    it('開き直したら、覚えていてロックが空いているセッションを interrupt で終わらせる', async () => {
        fakeLocks();
        remember();
        await setup();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        expect(ws.wire).toEqual([{ type: 'interrupt', session: SESSION }]);
        receive({ type: 'interrupted', session: SESSION, result: 'interrupted' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
        // 続きから録音できることを知らせる
        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(toasts.error.mock.calls[0][1].action.label).toBe('続きから録音');
    });

    it('もう終わっていたら、知らせずに忘れる', async () => {
        fakeLocks();
        remember();
        await setup();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        receive({ type: 'interrupted', session: SESSION, result: 'notRecording' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('ほかのタブが録音している（ロックを持っている）なら終わらせない', async () => {
        // 電波が切れただけで、そのタブがつなぎ直すのを待っているかもしれない（#101）
        fakeLocks([LOCK]);
        remember();
        await setup();
        await new Promise((r) => setTimeout(r, 20));
        expect(ws.log()).not.toContain('interrupt');
        expect(marks()).toHaveLength(1);
    });

    it('Web Locks が使えないブラウザでは終わらせない', async () => {
        remember();
        await setup();
        await new Promise((r) => setTimeout(r, 20));
        expect(ws.log()).not.toContain('interrupt');
    });

    it('ほかのホストで録音していたものは、そのホストにつないだときまで待つ', async () => {
        fakeLocks();
        localStorage.setItem(KEY, JSON.stringify([{ session: SESSION, host: 'other-host' }]));
        await setup();
        await new Promise((r) => setTimeout(r, 20));
        expect(ws.log()).not.toContain('interrupt');
        expect(marks()).toHaveLength(1);
    });

    it('届かなかった音声が残っていれば、送って続けられるので待つ。捨てたら終わらせる', async () => {
        fakeLocks();
        remember();
        await setup([{ session: SESSION, project: 'p1', host: null, frames: [frame(0, 8000)] }]);
        await vi.waitFor(() => expect(store.getState().unsent).not.toBeNull());
        await new Promise((r) => setTimeout(r, 20));
        expect(ws.log()).not.toContain('interrupt');

        await store.getState().discardUnsent();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        receive({ type: 'interrupted', session: SESSION, result: 'interrupted' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
    });

    it('ほかの接続が録音している（サーバーがまだ前の接続を切っていない）なら、少し待って確かめ直す', async () => {
        fakeLocks();
        remember();
        vi.useFakeTimers({ shouldAdvanceTime: true });
        await setup();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        receive({ type: 'interrupted', session: SESSION, result: 'connected' });
        await vi.waitFor(() => expect(marks()).toHaveLength(1));
        await vi.advanceTimersByTimeAsync(30000);
        await vi.waitFor(() => expect(ws.log().filter((t) => t === 'interrupt')).toHaveLength(2));
        receive({ type: 'interrupted', session: SESSION, result: 'interrupted' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
    });

    it('古いサーバー（interrupt を知らない）では、エラーを出さずに忘れる', async () => {
        fakeLocks();
        remember();
        await setup();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        receive({ type: 'error', code: 'bad_message', message: '知らない種類のメッセージです: interrupt' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('返事を待っている間のほかのエラーは返事とみなさず、トーストも出す', async () => {
        fakeLocks();
        remember();
        await setup();
        await vi.waitFor(() => expect(ws.log()).toContain('interrupt'));
        receive({ type: 'error', code: 'session_not_found', message: '再開できるセッションがありません' });
        expect(toasts.error).toHaveBeenCalledWith('再開できるセッションがありません');
        await new Promise((r) => setTimeout(r, 20));
        expect(marks()).toHaveLength(1);
        receive({ type: 'interrupted', session: SESSION, result: 'interrupted' });
        await vi.waitFor(() => expect(marks()).toEqual([]));
    });

    it('電波が切れただけなら、今まで通り resume で続け、interrupt は送らない', async () => {
        fakeLocks();
        await setup();
        await startRecording();
        mic.speak(8000);
        ws.disconnect();
        mic.speak(8000);
        ws.reconnect();
        await vi.waitFor(() => expect(ws.log()).toContain('resume'));
        await new Promise((r) => setTimeout(r, 20));
        expect(ws.log()).not.toContain('interrupt');
        expect(store.getState().recordingState).toBe('recording');
        expect(marks()).toHaveLength(1);
    });
});

describe('ページを閉じるとき（pagehide）', () => {
    function pagehide(persisted = false) {
        const event = new Event('pagehide') as PageTransitionEvent;
        Object.defineProperty(event, 'persisted', { value: persisted });
        window.dispatchEvent(event);
    }

    it('録音中で、届いていない音声がなければ interrupt を送る', async () => {
        fakeLocks();
        await setup();
        await startRecording();
        mic.speak(8000);
        receive({ type: 'ack', session: SESSION, seq: 0 });
        pagehide();
        expect(ws.log().slice(-1)).toEqual(['interrupt']);
    });

    it('届いていない音声があれば送らない（開き直したときに送って続ける）', async () => {
        fakeLocks();
        await setup();
        await startRecording();
        mic.speak(8000);
        pagehide();
        expect(ws.log()).not.toContain('interrupt');
    });

    it('戻ってくるかもしれないページ（bfcache）と、録音していないときは送らない', async () => {
        fakeLocks();
        await setup();
        pagehide();
        await startRecording();
        pagehide(true);
        expect(ws.log()).not.toContain('interrupt');
    });
});
