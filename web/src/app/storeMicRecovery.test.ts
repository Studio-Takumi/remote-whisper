import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { useAppStore as Store } from '@/app/store';
import { RETRY_DELAYS } from '@/features/recording/micRecovery';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects } from '@/test/seedProjects';

// 割り込みのあと、同じセッションのまま自動で録音に戻る（#447）
const SESSION = '2026-11-20_10-00-00';

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;

async function startRecording() {
    vi.resetModules();
    const { connection } = await import('@/api/connection');
    const { Microphone } = await import('@/features/recording/audio/microphone');
    ws = fakeConnection(connection);
    mic = fakeMicrophone(Microphone);
    ({ useAppStore: store } = await import('@/app/store'));
    await seedProjects(store, [{ id: 'p1', name: 'p1', path: '/p1', sessions: [] }]);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
    const starting = store.getState().startRecording();
    await vi.waitFor(() => expect(ws.log()).toContain('start'));
    ws.receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
    await starting;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
    vi.useRealTimers();
    await store?.getState().stopRecording();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('割り込みのあと録音に戻る', () => {
    it('マイクが止まったら開き直し、同じセッションのまま送り続ける（止まっていた間は詰める）', async () => {
        await startRecording();
        mic.speak(8000);
        mic.setState('muted');
        expect(store.getState().micState).toBe('muted');
        // 止まっている間は何も届かない
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(mic.opened).toBe(2);
        expect(mic.closed).toBe(1);
        expect(store.getState().micState).toBe('ok');
        mic.speak(8000);
        // start を送り直さず、連番も続く
        expect(ws.log()).toEqual(['start', 'audio:0', 'audio:1']);
        expect(store.getState().recordingSessionId).toBe(SESSION);
        expect(store.getState().elapsed).toBe(1);
    });

    it('一時停止の間は戻さず、再開したら戻す', async () => {
        await startRecording();
        await store.getState().pauseRecording();
        mic.setState('ended');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(mic.opened).toBe(1);
        expect(store.getState().recordingState).toBe('paused');
        store.getState().resumeRecording();
        await vi.advanceTimersByTimeAsync(0);
        expect(mic.opened).toBe(2);
        expect(store.getState().micState).toBe('ok');
    });

    it('開き直してもまだ止まっていれば、警告を出したまま次を待つ', async () => {
        await startRecording();
        mic.openState = 'muted';
        mic.setState('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(mic.opened).toBe(2);
        expect(store.getState().micState).toBe('muted');
        // 自然に戻ったら（unmute）、それ以上は試さない
        mic.setState('ok');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(mic.opened).toBe(2);
        expect(store.getState().micState).toBe('ok');
    });

    it('録音を終えたら戻さない', async () => {
        await startRecording();
        mic.setState('muted');
        await store.getState().stopRecording();
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(mic.opened).toBe(1);
    });
});
