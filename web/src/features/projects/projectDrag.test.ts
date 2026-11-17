import { describe, expect, it } from 'vitest';

import type { Project, Session } from '@/api/types';
import { dragName, pointerOnly } from '@/features/projects/projectDrag';
import { sortableId } from '@/features/projects/projectOrder';
import { sessionMeta } from '@/features/projects/sessionMeta';

const session = (patch: Partial<Session> = {}): Session => ({
    id: 's1',
    title: '第 1 回',
    startedAt: '2026-10-11T14:05:00+09:00',
    status: 'done',
    transcript: [],
    summaries: [],
    ...patch,
});

const projects: Project[] = [{ id: 'p1', name: '講義', path: '/p1', sessions: [session()] }];

describe('pointerOnly', () => {
    it('キーボードの操作だけを除く', () => {
        const onKeyDown = () => {};
        const onPointerDown = () => {};
        expect(pointerOnly({ onKeyDown, onPointerDown })).toEqual({ onPointerDown });
        expect(pointerOnly(undefined)).toEqual({});
    });
});

describe('dragName', () => {
    it('プロジェクト（並び替えの ID も）とセッションの名前を引く', () => {
        expect(dragName(projects, 'p1')).toBe('講義');
        expect(dragName(projects, sortableId('p1'))).toBe('講義');
        expect(dragName(projects, 'p1:s1')).toBe('第 1 回');
        expect(dragName(projects, 'p2:s1')).toBe('');
        expect(dragName(projects, null)).toBe('');
    });
});

describe('sessionMeta', () => {
    it('録音日時と長さ。録音中は「録音中」', () => {
        expect(sessionMeta(session({ status: 'recording' }))).toMatch(/ · 録音中$/);
        expect(sessionMeta(session({ durationSec: 3725 }))).toMatch(/ · 1:02:05$/);
        expect(sessionMeta(session())).not.toContain('·');
    });
});
