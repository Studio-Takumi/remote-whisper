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
        // stop（600 秒）の後に、話している途中だった最後の区間の final が届く
        { t: 603, msg: { type: 'title', title: '仮', provisional: true, session: SID } },
        { t: 605, msg: { type: 'final', segment: 1, start: 590, end: 595, text: '最後の一', session: SID } },
        { t: 608, msg: { type: 'final', segment: 2, start: 595, end: 600, text: '最後の二', session: SID } },
        { t: 700, msg: { type: 'title', title: '最終', provisional: false, session: SID } },
    ],
};

const doneData = {
    finalTranscripts: [],
    finalTranscriptLines: {},
    summaries: [],
    summaryTexts: {},
    transcript: {
        meta: {},
        lines: [
            { time: '00:00:01', text: 'こんにちは' },
            { time: '00:09:50', text: '最後の一' },
            { time: '00:09:55', text: '最後の二' },
        ],
    },
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
    it('録音を終えたときの recordingState は、stop の後に届いた最後の final の直後に足す（サーバーと同じ順）', () => {
        const timeline = replayTimeline(record, SID);
        expect(timeline.map((m) => [m.t, m.msg.type])).toEqual([
            [0.05, 'started'],
            [5, 'partial'],
            [10, 'final'],
            [603, 'title'],
            [605, 'final'],
            [608, 'final'],
            [608, 'recordingState'],
            [700, 'title'],
        ]);
        // stop の後に final がなければ、stop の時刻
        const plain = { stopAt: 600, messages: record.messages.slice(0, 3) };
        expect(replayTimeline(plain, SID).at(-1)).toMatchObject({ t: 600, msg: { type: 'recordingState' } });
    });

    it('stop の後の final は見ている間に届き、一覧の取り直しでも届く前の行は出ない', async () => {
        const { store, view } = setup();
        // 見ている間（stopped の前）に届いた final
        const watched: string[] = [];
        cleanups.push(
            connection.subscribe((m) => {
                if (m.type === 'final' && store.getState().watching) {
                    watched.push(m.text);
                }
            }),
        );
        store.setState({ selection: target });
        await vi.advanceTimersByTimeAsync(606_000);
        expect(store.getState().watching).not.toBeNull();
        // stop の後でも、stopped が届くまでは録音中の行で、届いた final までの行
        expect(view.row(PID, { id: SID, files: {} })).toMatchObject({ status: 'recording' });
        expect(view.session(PID, SID, doneData).transcript?.lines.map((l) => l.text)).toEqual([
            'こんにちは',
            '最後の一',
        ]);
        await vi.advanceTimersByTimeAsync(3_000);
        expect(watched).toEqual(['こんにちは', '最後の一', '最後の二']);
        expect(store.getState().watching).toBeNull();
        expect(view.row(PID, { id: SID, files: {} })).not.toMatchObject({ status: 'recording' });
        expect(view.session(PID, SID, doneData).transcript?.lines).toEqual(doneData.transcript.lines);
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
        expect(view.session(PID, SID, doneData).transcript?.lines).toEqual([]);
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
