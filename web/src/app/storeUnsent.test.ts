import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@/api/protocol';
import type { Project, Session } from '@/api/types';
import type { useAppStore as Store } from '@/app/store';
import type { UnsentSession } from '@/features/recording/audio/unsentStore';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects, sessionReader } from '@/test/seedProjects';

// 届かなかった音声の扱い（#380）。store から録音を出す前に、今の動きを固定する
const SESSION = '2026-11-17_10-00-00';

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;

// 連番 seq のチャンク（先頭 4 バイトが連番、あとは samples 個の無音）
function frame(seq: number, samples: number) {
    const buffer = new ArrayBuffer(4 + samples * 2);
    new DataView(buffer).setUint32(0, seq, true);
    return { seq, frame: buffer };
}

async function setup(projects: Project[], unsent: UnsentSession[] = []) {
    vi.resetModules();
    vi.doMock('@/features/recording/audio/unsentStore', async (importOriginal) => ({
        ...(await importOriginal<object>()),
        listUnsent: async () => unsent,
        saveChunk: async () => true,
        deleteUpTo: async () => {},
        clearSession: async () => {},
        restoreSize: () => {},
    }));
    const { connection } = await import('@/api/connection');
    const { Microphone } = await import('@/features/recording/audio/microphone');
    ws = fakeConnection(connection);
    mic = fakeMicrophone(Microphone);
    ({ useAppStore: store } = await import('@/app/store'));
    // 一覧と中身はキャッシュに入れる（#361）
    await seedProjects(store, projects);
    readSession = await sessionReader(store);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
}

function receive(message: ServerMessage) {
    ws.receive(message);
}

let readSession: (id: string) => Session | undefined;

function session() {
    return readSession(SESSION);
}

const interrupted = {
    id: SESSION,
    title: '講義',
    startedAt: '2026-11-17 10:00',
    status: 'interrupted' as const,
    transcript: [],
    summaries: [],
};

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
    vi.doUnmock('@/features/recording/audio/unsentStore');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('届かなかった音声', () => {
    it('読み込み直す前の音声を resume で送り直し、経過時間は受け取り済みの長さから続ける', async () => {
        const entry = { session: SESSION, project: 'p1', host: null, frames: [frame(0, 8000), frame(1, 8000)] };
        await setup([{ id: 'p1', name: 'p1', path: '/p1', sessions: [interrupted] }], [entry]);
        await vi.waitFor(() =>
            expect(store.getState().unsent).toEqual({ sessionId: SESSION, projectId: 'p1', seconds: 1 }),
        );

        const recovering = store.getState().recoverUnsent();
        await vi.waitFor(() => expect(ws.log()).toContain('resume'));
        expect(ws.wire).toEqual([{ type: 'resume', session: SESSION, nextSeq: 0 }]);
        receive({ type: 'started', session: SESSION, resumed: true, offsetSec: 1.5 });
        await recovering;
        const s = store.getState();
        expect(s.unsent).toBeNull();
        expect(s.recordingState).toBe('recording');
        expect(s.recordingSessionId).toBe(SESSION);
        expect(s.elapsed).toBe(1);
        expect(session()?.status).toBe('recording');

        // サーバーは連番 0 まで受け取っていた。残りを送り直し、経過時間は受け取り済み＋残りの長さにする
        receive({ type: 'ack', session: SESSION, seq: 0 });
        expect(ws.log()).toEqual(['resume', 'audio:1', 'unpause']);
        expect(store.getState().elapsed).toBe(2);
        expect(mic.opened).toBe(1);
    });

    it('届かなかった音声を捨てる', async () => {
        const entry = { session: SESSION, project: 'p1', host: null, frames: [frame(0, 8000)] };
        await setup([{ id: 'p1', name: 'p1', path: '/p1', sessions: [interrupted] }], [entry]);
        await vi.waitFor(() => expect(store.getState().unsent).not.toBeNull());
        await store.getState().discardUnsent();
        expect(store.getState().unsent).toBeNull();
        await store.getState().recoverUnsent();
        expect(ws.wire).toEqual([]);
    });

    it('途中で終わった録音の続きでは、届かなかった音声を頭に送る', async () => {
        await setup([{ id: 'p1', name: 'p1', path: '/p1', sessions: [] }]);
        const starting = store.getState().startRecording();
        await vi.waitFor(() => expect(ws.log()).toContain('start'));
        receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
        await starting;
        mic.speak(8000);
        ws.disconnect();
        mic.speak(8000);
        ws.reconnect();
        await vi.waitFor(() => expect(ws.log()).toContain('resume'));
        receive({ type: 'error', session: SESSION, code: 'session_not_found', message: 'not found' });
        await vi.waitFor(() => expect(session()?.status).toBe('interrupted'));

        const continuing = store.getState().continueRecording(SESSION);
        await vi.waitFor(() => expect(ws.log()).toContain('continue'));
        receive({ type: 'started', session: SESSION, offsetSec: 1 });
        await continuing;
        // 新しい連番で、届かなかった 2 チャンクを先に送る
        expect(ws.log().slice(-3)).toEqual(['continue', 'audio:0', 'audio:1']);
        expect(store.getState().recordingSessionId).toBe(SESSION);
        expect(store.getState().elapsed).toBe(2);
        expect(session()?.status).toBe('recording');
    });
});
