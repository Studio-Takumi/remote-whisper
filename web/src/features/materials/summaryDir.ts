import { type ProjectJson, api } from '@/api/api';
import { isDemo, projectsQuery } from '@/api/data';
import { queryClient } from '@/app/query';

// 最終要約のコピーの置き場所（project.json の summaryDir。spec/files.md 5.4 節、#341）を保存する。
// 検証はサーバーがする（不正なら 422 の ApiError）。サーバーがそろえた値（./summary/ → summary）を返し、
// キャッシュのプロジェクトの一覧に入れる（画面のプロジェクトはキャッシュから読む。#361）
export async function saveSummaryDir(projectId: string, value: string): Promise<string> {
    const summaryDir = isDemo
        ? value
        : ((await api.patch<ProjectJson>(`/api/projects/${projectId}`, { summaryDir: value })).summaryDir ?? '');
    queryClient.setQueryData(projectsQuery.queryKey, (list) =>
        list?.map((p) => (p.id === projectId ? { ...p, summaryDir } : p)),
    );
    return summaryDir;
}
