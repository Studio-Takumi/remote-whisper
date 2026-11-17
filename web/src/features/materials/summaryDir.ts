import { type ProjectJson, api } from '@/api/api';
import { isDemo } from '@/api/demo';
import { projectsQuery } from '@/api/projects';
import { queryClient } from '@/app/query';

// 最終要約のコピーの置き場所（summaryDir。spec/files.md 5.4、#341）を保存する。検証はサーバー（不正は 422 の ApiError）。
// 返った値をキャッシュのプロジェクトの一覧に入れる（#361）
export async function saveSummaryDir(projectId: string, value: string): Promise<string> {
    const summaryDir = isDemo
        ? value
        : ((await api.patch<ProjectJson>(`/api/projects/${projectId}`, { summaryDir: value })).summaryDir ?? '');
    queryClient.setQueryData(projectsQuery.queryKey, (list) =>
        list?.map((p) => (p.id === projectId ? { ...p, summaryDir } : p)),
    );
    return summaryDir;
}
