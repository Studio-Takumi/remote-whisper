import { describe, expect, it } from 'vitest';

import type { Project } from '@/api/types';
import { findJobSession, gpuTriggerLabel, waitingCount } from '@/app/gpuJobs';

describe('waitingCount', () => {
    it('まとめてあるものは count の分を数える', () => {
        expect(
            waitingCount({
                running: null,
                waiting: [
                    { kind: 'liveSummary', session: null, count: 2, waitingSec: 0 },
                    { kind: 'terms', session: null, count: 1, waitingSec: 0 },
                ],
            }),
        ).toBe(3);
    });
});

describe('gpuTriggerLabel', () => {
    it('使用率と待ちの数が分かれば括弧に入れる', () => {
        expect(gpuTriggerLabel(null, 0)).toBe('GPU の状態とジョブの一覧');
        expect(gpuTriggerLabel({ util: 42, memUsedMb: 0, memTotalMb: 0 }, 0)).toBe(
            'GPU の状態とジョブの一覧（使用率 42%）',
        );
        expect(gpuTriggerLabel({ util: 0, memUsedMb: 0, memTotalMb: 0 }, 3)).toBe(
            'GPU の状態とジョブの一覧（使用率 0%、待ち 3 件）',
        );
    });
});

describe('findJobSession', () => {
    const projects = [
        {
            id: 'p1',
            name: 'p',
            path: '/p',
            sessions: [
                {
                    id: 's1',
                    uuid: 'u1',
                    title: '第 1 回',
                    startedAt: '',
                    status: 'done',
                    transcript: [],
                    summaries: [],
                },
            ],
        },
    ] as Project[];

    it('セッションがあれば飛び先を、なければリンクにしない', () => {
        expect(findJobSession(projects, 's1')).toEqual({
            title: '第 1 回',
            href: '/s/u1',
            projectId: 'p1',
            sessionId: 's1',
        });
        expect(findJobSession(projects, 'gone')).toEqual({ title: 'gone', href: null });
        expect(findJobSession(projects, null)).toBeNull();
    });
});
