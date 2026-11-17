import { describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import type { Session } from '@/api/types';
import type { AppState, AppStore } from '@/app/appState';
import { applyLive } from '@/features/recording/recordingMessages';

// 録音中・見ている録音の行を入れる先（#361）。手元のセッションならストアに、メッセージのセッションにだけ当てる

const S = 'S1';
const OTHER = 'S2';

function session(id: string): Session {
    return {
        id,
        title: id,
        startedAt: '2026-11-17 10:00',
        status: 'recording',
        transcript: [{ time: '00:00:00', text: '前の行' }],
        summaries: [],
    };
}

function store(localIds: string[]): AppStore {
    const state = {
        partials: [],
        liveDraft: null,
        localSessions: localIds.map((id) => ({ projectId: 'p1', session: session(id) })),
        loadedSessions: {},
    } as unknown as AppState;
    return createStore<AppState>()(() => state);
}

const final = { type: 'final', session: S, segment: 0, start: 1, end: 2, text: '続き' } as const;

describe('applyLive', () => {
    it('手元のセッションの行は、そのセッションにだけ足す（ほかの手元のセッションはそのまま）', () => {
        const st = store([S, OTHER]);
        const other = st.getState().localSessions[1].session;
        applyLive(st, final);
        const [s, o] = st.getState().localSessions;
        expect(s.session.transcript.map((l) => l.text)).toEqual(['前の行', '続き']);
        expect(o.session).toBe(other);
    });

    it('手元にないセッション（見ている録音）では、手元のセッションの一覧を作り直さない', () => {
        const st = store([OTHER]);
        const before = st.getState().localSessions;
        applyLive(st, final);
        expect(st.getState().localSessions).toBe(before);
    });
});
