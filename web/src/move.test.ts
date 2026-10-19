import { describe, expect, it } from 'vitest';

import { type MoveState, moveBlocker, moveTarget } from '@/move';
import type { Session } from '@/types';

const session = { id: 's1', title: 't', status: 'done', startedAt: '' } as unknown as Session;
const idle: MoveState = {
    jobs: { running: null, waiting: [] },
    transcribing: [],
    summarizing: [],
    recordingSessionId: null,
};

describe('moveBlocker', () => {
    it('録音を終えて何もしていなければ移せる', () => {
        expect(moveBlocker(session, idle)).toBeNull();
    });

    it('録音中・浄書中・要約中・GPU のジョブがあるときは移せない', () => {
        expect(moveBlocker({ ...session, status: 'recording' }, idle)).toContain('録音中');
        expect(moveBlocker(session, { ...idle, recordingSessionId: 's1' })).toContain('録音中');
        expect(moveBlocker(session, { ...idle, transcribing: ['s1'] })).toContain('浄書');
        expect(moveBlocker(session, { ...idle, summarizing: ['s1'] })).toContain('要約');
        const waiting = [{ kind: 'finalSummary' as const, session: 's1', count: 1, waitingSec: 0 }];
        expect(moveBlocker(session, { ...idle, jobs: { running: null, waiting } })).toContain('GPU');
    });

    it('ほかのセッションのジョブは関係ない', () => {
        expect(moveBlocker(session, { ...idle, transcribing: ['s2'], summarizing: ['s3'] })).toBeNull();
    });
});

describe('moveTarget', () => {
    it('同じプロジェクトや外で離したときは移さない', () => {
        expect(moveTarget('a', 'a')).toBeNull();
        expect(moveTarget('a', null)).toBeNull();
        expect(moveTarget('a', 'b')).toBe('b');
    });
});
