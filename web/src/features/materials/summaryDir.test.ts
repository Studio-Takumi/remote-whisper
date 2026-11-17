import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ProjectJson, api } from '@/api/api';
import { projectsQuery } from '@/api/projects';
import { queryClient } from '@/app/query';
import { readProjects } from '@/app/sessionData';
import { useAppStore } from '@/app/store';
import { saveSummaryDir } from '@/features/materials/summaryDir';

// 最終要約のコピーの置き場所（#341）を取る・保存する

const selection = { contextSet: null, useHotwords: true, useContext: true };
const project = (id: string, summaryDir?: string): ProjectJson => ({
    id,
    name: id,
    path: `/work/${id}`,
    selection,
    ...(summaryDir === undefined ? {} : { summaryDir }),
});

beforeEach(() => {
    queryClient.clear();
    useAppStore.setState({ localSessions: [] });
});

// 画面に出すプロジェクトの一覧（#361 からキャッシュから作る）
const shownProjects = () => readProjects(useAppStore.getState());

afterEach(() => {
    vi.restoreAllMocks();
});

describe('summaryDir', () => {
    it('一覧から取る。古いサーバー（summaryDir なし）では undefined のまま', async () => {
        vi.spyOn(api, 'get').mockResolvedValue([project('a', 'summary'), project('b')]);
        const list = await queryClient.fetchQuery(projectsQuery);
        expect(list.map((p) => p.summaryDir)).toEqual(['summary', undefined]);
    });

    it('保存すると、サーバーがそろえた値をキャッシュと手元のプロジェクトに入れる', async () => {
        queryClient.setQueryData(projectsQuery.queryKey, [
            { id: 'a', name: 'a', path: '/work/a', summaryDir: '' },
            { id: 'b', name: 'b', path: '/work/b', summaryDir: 'x' },
        ]);
        const patch = vi.spyOn(api, 'patch').mockResolvedValue(project('a', 'notes/summary'));

        expect(await saveSummaryDir('a', '.\\notes\\summary\\')).toBe('notes/summary');
        expect(patch).toHaveBeenCalledWith('/api/projects/a', { summaryDir: '.\\notes\\summary\\' });
        expect(queryClient.getQueryData(projectsQuery.queryKey)?.map((p) => p.summaryDir)).toEqual([
            'notes/summary',
            'x',
        ]);
        expect(shownProjects().map((p) => p.summaryDir)).toEqual(['notes/summary', 'x']);
    });

    it('弾かれたら（422）、何も変えずにエラーを投げる', async () => {
        queryClient.setQueryData(projectsQuery.queryKey, [
            { id: 'a', name: 'a', path: '/work/a', summaryDir: 'summary' },
        ]);
        vi.spyOn(api, 'patch').mockRejectedValue(new ApiError(422, '`..` は使えません'));

        await expect(saveSummaryDir('a', '../x')).rejects.toThrow('`..` は使えません');
        expect(shownProjects()[0].summaryDir).toBe('summary');
    });
});
