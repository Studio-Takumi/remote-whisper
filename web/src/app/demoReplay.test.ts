import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';

import { connection } from '@/api/connection';
import { ReplayView } from '@/api/demoReplayView';
import type { DemoReplay } from '@/api/demoTypes';
import type { ServerMessage } from '@/api/protocol';
import type { AppState } from '@/app/appState';
import { DemoReplayEntry, replayTimeline } from '@/app/demoReplay';

// 入口（開いたら最初から再生・閉じたら止める）を、偽の時計で短く回す（実時間の 21 分は待たない）
const PID = 'r1';
const SID = '20261111-161646';
const target = { projectId: PID, sessionId: SID };

const record: DemoReplay = {
    stopAt: 600,
    messages: [
        { t: 0.05, msg: { type: 'started', sessionUuid: 'u', session: SID } },
        { t: 5, msg: { type: 'partial', segment: 0, committed: '', tentative: 'こん', session: SID } },
        { t: 10, msg: { type: 'final', segment: 0, start: 1, end: 2, text: 'こんにちは', session: SID } },
        { t: 700, msg: { type: 'title', title: '最終', provisional: false, session: SID } },
    ],
};

let received: ServerMessage[];
let cleanups: (() => void)[];

beforeEach(() => {
    vi.useFakeTimers();
    received = [];
    cleanups = [connection.subscribe((m) => received.push(m))];
});

afterEach(() => {
    cleanups.forEach((f) => f());
    vi.useRealTimers();
});

function setup() {
    const loadProjects = vi.fn(() => Promise.resolve());
    const store = createStore<AppState>(
        () =>
            ({
                selection: { projectId: null, sessionId: null },
                watching: null,
                generating: null,
                loadedSessions: {},
                loadProjects,
            }) as unknown as AppState,
    );
    // 本物の Watcher の代わりに、見ているかどうかだけ覚える
    const unsubscribe = connection.subscribe((m) => {
        if (m.type === 'watching') {
            store.setState({ watching: { sessionId: m.session, state: 'recording' } });
        } else if (m.type === 'recordingState' && m.state === 'stopped') {
            store.setState({ watching: null });
        }
    });
    cleanups.push(unsubscribe);
    const view = new ReplayView(target);
    const entry = new DemoReplayEntry(store, { target, view, load: () => Promise.resolve(record) });
    entry.attach();
    return { store, view, loadProjects };
}

const types = () => received.map((m) => m.type);

describe('DemoReplayEntry', () => {
    it('録音を終えたときの recordingState を、stop の時刻に足す', () => {
        const timeline = replayTimeline(record, SID);
        expect(timeline.map((m) => [m.t, m.msg.type])).toEqual([
            [0.05, 'started'],
            [5, 'partial'],
            [10, 'final'],
            [600, 'recordingState'],
            [700, 'title'],
        ]);
    });

    it('開いたら、見始めの watching を流してから、記録の時刻どおりに流す', async () => {
        const { store, view, loadProjects } = setup();
        store.setState({ selection: target });
        await vi.advanceTimersByTimeAsync(0);
        expect(loadProjects).toHaveBeenCalled();
        expect(types()).toEqual(['watching']);
        await vi.advanceTimersByTimeAsync(100);
        expect(types()).toEqual(['watching', 'started']);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(types()).toEqual(['watching', 'started', 'partial', 'final']);
        // 一覧の行は、流したところまでの形（録音中）
        expect(view.row(PID, { id: SID, files: {} })).toMatchObject({ status: 'recording' });
        await vi.advanceTimersByTimeAsync(700_000);
        expect(types().slice(-2)).toEqual(['recordingState', 'title']);
        // 最後まで行ったら、同梱したままの形で止まる
        const row = { id: SID, files: {} };
        expect(view.row(PID, row)).toBe(row);
    });

    it('途中で閉じたら止まり、見ている状態と GPU の表示を消して、録音中の形に戻す', async () => {
        const { store, view, loadProjects } = setup();
        store.setState({ selection: target });
        await vi.advanceTimersByTimeAsync(6_000);
        expect(types()).toEqual(['watching', 'started', 'partial']);
        loadProjects.mockClear();
        store.setState({ selection: { projectId: 'home', sessionId: '20260101-000000' } });
        expect(types().slice(-2)).toEqual(['recordingState', 'status']);
        expect(loadProjects).toHaveBeenCalled();
        const count = received.length;
        await vi.advanceTimersByTimeAsync(2000_000);
        expect(received.length).toBe(count);
        expect(
            view.session(PID, SID, {
                finalTranscripts: [],
                finalTranscriptLines: {},
                summaries: [],
                summaryTexts: {},
                transcript: { meta: {}, lines: [{ time: '00:00:01', text: 'x' }] },
            }).transcript?.lines,
        ).toEqual([]);
    });

    it('もう一度開いたら最初から', async () => {
        const { store } = setup();
        store.setState({ selection: target });
        await vi.advanceTimersByTimeAsync(11_000);
        store.setState({ selection: { projectId: null, sessionId: null } });
        received.length = 0;
        store.setState({ selection: target });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(types()).toEqual(['watching', 'started', 'partial']);
    });

    it('記録を読んでいる間に閉じたら、始めない', async () => {
        const { store } = setup();
        store.setState({ selection: target });
        store.setState({ selection: { projectId: null, sessionId: null } });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(types()).not.toContain('watching');
        expect(types()).not.toContain('partial');
    });
});
