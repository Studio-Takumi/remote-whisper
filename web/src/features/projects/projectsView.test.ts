import { describe, expect, it } from 'vitest';

import type { Session } from '@/api/types';
import { buildProjects, needsReload } from '@/features/projects/projectsView';

// 一覧の取り直しと、手元で積み上げているセッション（#361。前は api/data.ts の mergeProjects）

function session(id: string, extra: Partial<Session> = {}): Session {
    return {
        id,
        title: id,
        startedAt: '2026-10-01 09:00',
        status: 'done',
        files: { recording: true, transcript: true, summaries: 1, liveSummary: false },
        transcript: [],
        summaries: [],
        ...extra,
    };
}

const info = { id: 'p', name: 'p', path: '' };

describe('needsReload', () => {
    it('ファイルが変わっていなければ、前に取った中身を使う', () => {
        expect(needsReload(session('s1'), session('s1'))).toBe(false);
    });

    it('ファイルが増えたものは取り直す', () => {
        const next = session('s1', { files: { recording: true, transcript: true, summaries: 2, liveSummary: false } });
        expect(needsReload(session('s1'), next)).toBe(true);
    });

    it('録音中だったものは取り直す', () => {
        expect(needsReload(session('s1', { status: 'recording' }), session('s1'))).toBe(true);
    });

    it('前になかったものは、まだ中身を取っていない', () => {
        expect(needsReload(undefined, session('s1'))).toBe(false);
    });
});

describe('buildProjects', () => {
    it('手元で積み上げているものは手元のまま。サーバーの一覧になければ先頭に足す', () => {
        const local = session('s0', { status: 'recording', transcript: [{ time: '00:00:01', text: '録音中' }] });
        const [p] = buildProjects([info], [[session('s1')]], [{ projectId: 'p', session: local }]);
        expect(p.sessions.map((s) => s.id)).toEqual(['s0', 's1']);
        expect(p.sessions[0]).toBe(local);
    });

    it('一覧にあるものは、手元のものに置き換える（並びは一覧のまま）', () => {
        const local = session('s2', { title: '手元のタイトル' });
        const [p] = buildProjects(
            [info],
            [[session('s1'), session('s2'), session('s3')]],
            [{ projectId: 'p', session: local }],
        );
        expect(p.sessions.map((s) => s.title)).toEqual(['s1', '手元のタイトル', 's3']);
    });

    it('ほかのプロジェクトの手元のセッションは入れない', () => {
        const [p] = buildProjects([info], [undefined], [{ projectId: 'q', session: session('s0') }]);
        expect(p.sessions).toEqual([]);
    });
});
