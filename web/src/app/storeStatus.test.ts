import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@/api/protocol';
import type { useAppStore as Store } from '@/app/store';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects } from '@/test/seedProjects';

// status と最終の要約の受け取り（#380）。connectServer を分ける前に、今の動きを固定する
const SESSION = '2026-11-17_10-00-00';

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;
let toastError: ReturnType<typeof vi.fn>;

const status = (summarizing: string[]): ServerMessage => ({
    type: 'status',
    whisper: 'ready',
    ollama: 'ready',
    recordings: 0,
    queue: 0,
    summarizing,
});

async function setup() {
    vi.resetModules();
    const { connection } = await import('@/api/connection');
    const { Microphone } = await import('@/features/recording/audio/microphone');
    const { toast } = await import('sonner');
    toastError = vi.fn();
    vi.spyOn(toast, 'error').mockImplementation(toastError as never);
    ws = fakeConnection(connection);
    mic = fakeMicrophone(Microphone);
    ({ useAppStore: store } = await import('@/app/store'));
    // 一覧はキャッシュに入れる（#361）
    await seedProjects(store, [{ id: 'p1', name: 'p1', path: '/p1', sessions: [] }]);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
}

// 録音して止め、最終の要約を待っている状態にする
async function recordAndStop() {
    await setup();
    // つないだ直後の status は受け取り済み
    ws.receive(status([]));
    const starting = store.getState().startRecording();
    await vi.waitFor(() => expect(ws.log()).toContain('start'));
    ws.receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
    await starting;
    mic.speak(8000);
    await store.getState().stopRecording();
    expect(store.getState().generating?.sessionId).toBe(SESSION);
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('status と最終の要約', () => {
    it('status をサーバーの状態に入れる', async () => {
        await setup();
        ws.receive({ ...status([SESSION]), transcribing: ['x'] } as ServerMessage);
        expect(store.getState().server).toMatchObject({
            whisper: 'ready',
            ollama: 'ready',
            summarizing: [SESSION],
            transcribing: ['x'],
        });
    });

    it('最終の要約は少しずつ積み、summarizing から外れたら「作成中」を消す', async () => {
        await recordAndStop();
        ws.receive({ type: 'summary.delta', session: SESSION, kind: 'final', text: '要' });
        ws.receive({ type: 'summary.delta', session: SESSION, kind: 'final', text: '約' });
        expect(store.getState().generating).toMatchObject({ sessionId: SESSION, text: '要約' });

        ws.receive(status([SESSION]));
        expect(store.getState().generating).not.toBeNull();
        ws.receive(status([]));
        await vi.waitFor(() => expect(store.getState().generating).toBeNull());
    });

    it('つながり直した直後の status で、もう作っていなければ「作成中」を消す', async () => {
        await recordAndStop();
        ws.disconnect();
        ws.reconnect();
        ws.receive(status([]));
        await vi.waitFor(() => expect(store.getState().generating).toBeNull());
    });

    it('止めた直後に、止める前の status が遅れて届いても「作成中」のまま', async () => {
        await recordAndStop();
        ws.receive(status([]));
        ws.receive(status([]));
        await new Promise((r) => setTimeout(r, 0));
        expect(store.getState().generating?.sessionId).toBe(SESSION);
    });

    it('要約に失敗した error で「作成中」を消し、知らせる', async () => {
        await recordAndStop();
        ws.receive({ type: 'error', session: SESSION, code: 'summary_failed', message: '要約を作れません' });
        expect(store.getState().generating).toBeNull();
        expect(toastError).toHaveBeenCalledWith('要約を作れません');
    });

    it('録音を始める間の error は、始める処理がまとめて知らせる（二重に出さない）', async () => {
        await setup();
        const starting = store.getState().startRecording();
        await vi.waitFor(() => expect(ws.log()).toContain('start'));
        ws.receive({ type: 'error', code: 'already_recording', message: '録音中です' });
        await starting;
        expect(toastError).toHaveBeenCalledTimes(1);
        expect(store.getState().recordingState).toBe('idle');
    });
});
