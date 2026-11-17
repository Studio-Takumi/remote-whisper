import { queryOptions } from '@tanstack/react-query';

import { type ProjectJson, api } from '@/api/api';
import { sessionsQuery } from '@/api/sessions';
import type { ContextSelection, Project } from '@/api/types';
import { KEEP, queryClient, queryKeys } from '@/app/query';

// プロジェクト（セッションの一覧を除いたもの）
export type ProjectInfo = Omit<Project, 'sessions'>;

export function toSelection(json: ProjectJson['selection']): ContextSelection {
    return {
        setId: json.contextSet,
        useHotwords: json.useHotwords,
        useContext: json.useContext,
        pickTerms: json.pickTerms ?? true,
    };
}

// プロジェクトの一覧（queryKeys.projects()）。並びはサーバーが返したまま（設定の projectOrder の順）
export const projectsQuery = queryOptions({
    ...KEEP,
    queryKey: queryKeys.projects(),
    queryFn: async (): Promise<ProjectInfo[]> => {
        const projects = await api.get<ProjectJson[]>('/api/projects');
        return projects.map((p) => ({
            id: p.id,
            uuid: p.uuid,
            name: p.name,
            path: p.path,
            selection: toSelection(p.selection),
            summaryDir: p.summaryDir,
        }));
    },
});

// プロジェクトの一覧と、それぞれのセッションの一覧（文字起こしと要約の中身は、開いたときに取る）。
// どれもキャッシュがあっても取り直す（同時に頼まれたら 1 回にまとめる。取れなければ、キャッシュは前のまま）
export async function fetchProjects(): Promise<Project[]> {
    const projects = await queryClient.fetchQuery({ ...projectsQuery, staleTime: 0 });
    return Promise.all(
        projects.map(async (p) => ({
            ...p,
            sessions: await queryClient.fetchQuery({ ...sessionsQuery(p.id), staleTime: 0 }),
        })),
    );
}
