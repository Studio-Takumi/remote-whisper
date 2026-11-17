import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { api as Api } from '@/api/api';
import type { connection as Connection } from '@/api/connection';
import type { ServerMessage } from '@/api/protocol';
import type { useAppStore as Store } from '@/app/store';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';

// 常時の購読と、作り直しの返事より先に要約ができたとき（#397 のレビューの気づき）
const SESSION = '2026-11-17_10-00-00';

let store: typeof Store;
let ws: FakeConnection;
let connection: typeof Connection;
let api: typeof Api;

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
    ({ connection } = await import('@/api/connection'));
    ({ api } = await import('@/api/api'));
    ws = fakeConnection(connection);
    ({ useAppStore: store } = await import('@/app/store'));
    const { seedProjects } = await import('@/test/seedProjects');
    await seedProjects(store, [
        {
            id: 'p1',
            name: 'p1',
            path: '/p1',
            sessions: [
                {
                    id: SESSION,
                    title: '講義',
                    startedAt: '2026-11-17 10:00',
                    status: 'done',
                    transcript: [],
                    summaries: [],
                },
            ],
        },
    ]);
    store.setState({ selection: { projectId: 'p1', sessionId: null }, projectsLoaded: true });
    store.getState().connectServer();
}

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('常時の購読', () => {
    it('connectServer を 2 回呼んでも、購読と接続は 1 つ', async () => {
        await setup();
        store.getState().connectServer();
        expect(connection.subscribe).toHaveBeenCalledTimes(1);
        expect(connection.onStateChange).toHaveBeenCalledTimes(1);
        expect(connection.start).toHaveBeenCalledTimes(1);
    });
});

describe('最終の要約の作り直し', () => {
    it('返事が先なら、届くまで「作成中」にする', async () => {
        await setup();
        ws.receive(status([]));
        vi.spyOn(api, 'post').mockResolvedValue({ model: 'gemma' });
        await store.getState().regenerateSummary(SESSION);
        expect(store.getState().generating).toMatchObject({ sessionId: SESSION, text: '' });
    });

    it('返事より先に作り終えていたら「作成中」にせず、保存されたものを取り直す', async () => {
        await setup();
        ws.receive(status([]));
        let reply: (v: unknown) => void = () => {};
        vi.spyOn(api, 'post').mockImplementation(() => new Promise((r) => (reply = r)));
        const regenerating = store.getState().regenerateSummary(SESSION);
        await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
        // 返事の前に、作り始めて作り終えた
        ws.receive(status([SESSION]));
        ws.receive(status([]));
        const get = vi.spyOn(api, 'get');
        reply({ model: 'gemma' });
        await regenerating;
        expect(store.getState().generating).toBeNull();
        // 一覧とセッションの中身を取り直す
        await vi.waitFor(() => expect(get).toHaveBeenCalled());
    });
});
