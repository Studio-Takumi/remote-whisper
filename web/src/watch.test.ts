import { describe, expect, it } from 'vitest';

import type { Project, Session } from '@/types';
import { describeWatched, recordedElsewhere, watchTarget } from '@/watch';

function session(id: string, status: Session['status']): Session {
    return { id, status } as Session;
}

const projects = [
    { id: 'p1', sessions: [session('rec', 'recording'), session('done', 'done')] },
] as unknown as Project[];

describe('watchTarget', () => {
    it('開いているセッションがほかのクライアントで録音中なら見る', () => {
        expect(watchTarget(projects, { projectId: 'p1', sessionId: 'rec' }, null)).toBe('rec');
    });

    it('自分で録音しているセッション・録音を終えたセッション・新規セッション画面は見ない', () => {
        expect(watchTarget(projects, { projectId: 'p1', sessionId: 'rec' }, 'rec')).toBeNull();
        expect(watchTarget(projects, { projectId: 'p1', sessionId: 'done' }, null)).toBeNull();
        expect(watchTarget(projects, { projectId: 'p1', sessionId: null }, null)).toBeNull();
        expect(watchTarget(projects, { projectId: 'p1', sessionId: 'gone' }, null)).toBeNull();
    });
});

describe('recordedElsewhere', () => {
    it('録音中で、自分で録音していないもの', () => {
        expect(recordedElsewhere(session('rec', 'recording'), null)).toBe(true);
        expect(recordedElsewhere(session('rec', 'recording'), 'rec')).toBe(false);
        expect(recordedElsewhere(session('done', 'done'), null)).toBe(false);
        expect(recordedElsewhere(undefined, null)).toBe(false);
    });
});

describe('describeWatched', () => {
    it('状態ごとの説明', () => {
        expect(describeWatched(undefined)).toBe('ほかの端末で録音中');
        expect(describeWatched('recording')).toBe('ほかの端末で録音中');
        expect(describeWatched('paused')).toBe('ほかの端末で一時停止中');
        expect(describeWatched('disconnected')).toContain('つながりが切れています');
    });
});
