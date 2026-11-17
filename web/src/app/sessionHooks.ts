// 画面の部品が読むプロジェクトとセッション（#361）。キャッシュは useQuery で見て（取りには行かない。取るのは
// ストアの操作）、手元で積み上げているセッションはストアから読んで重ねる
import { useMemo } from 'react';

import { type QueryObserverResult, useQueries, useQuery } from '@tanstack/react-query';

import {
    finalTranscriptQuery,
    finalTranscriptsQuery,
    liveSummaryQuery,
    projectsQuery,
    sessionsQuery,
    summariesQuery,
    summaryQuery,
    transcriptQuery,
} from '@/api/data';
import type { Project, Session } from '@/api/types';
import { useAppStore } from '@/app/store';
import { buildProjects } from '@/features/projects/projectsView';
import { type SessionParts, sessionFrom } from '@/features/session/sessionDetail';

// 毎回同じ参照を返すように、空のときも定数を返す
const NO_PROJECTS: Project[] = [];
// キャッシュを見るだけ
const READ_ONLY = { enabled: false } as const;

function dataOf<T>(results: QueryObserverResult<T>[]) {
    return results.map((r) => r.data);
}

// プロジェクトの一覧。手元のセッション以外は、一覧の行だけ（中身は useCurrentSession で読む）
export function useProjectList(): Project[] {
    const local = useAppStore((s) => s.localSessions);
    const { data: infos } = useQuery({ ...projectsQuery, ...READ_ONLY });
    const lists = useQueries({
        queries: (infos ?? []).map((p) => ({ ...sessionsQuery(p.id), ...READ_ONLY })),
        combine: dataOf,
    });
    return useMemo(() => buildProjects(infos ?? [], lists, local), [infos, lists, local]);
}

// 画面に出すプロジェクトの一覧（開発用パネルで 0 件にしているときは空）
export function useProjects(): Project[] {
    const noProjects = useAppStore((s) => s.noProjects);
    const projects = useProjectList();
    return noProjects ? NO_PROJECTS : projects;
}

// セッションのタイトル（見つからなければ undefined）
export function useSessionTitle(sessionId: string | null | undefined): string | undefined {
    const projects = useProjectList();
    return projects.flatMap((p) => p.sessions).find((x) => x.id === sessionId)?.title;
}

export function useCurrentProject(): Project | undefined {
    const projectId = useAppStore((s) => s.selection.projectId);
    const projects = useProjects();
    return projects.find((p) => p.id === projectId);
}

function useSessionParts(projectId: string, sessionId: string, gid: string | undefined): SessionParts {
    const transcript = useQuery({ ...transcriptQuery(projectId, sessionId), ...READ_ONLY }).data;
    const finalTranscripts = useQuery({ ...finalTranscriptsQuery(projectId, sessionId), ...READ_ONLY }).data;
    const final = useQuery({ ...finalTranscriptQuery(projectId, sessionId, gid ?? ''), ...READ_ONLY }).data;
    const summaryInfos = useQuery({ ...summariesQuery(projectId, sessionId), ...READ_ONLY }).data;
    const summaryTexts = useQueries({
        queries: (summaryInfos ?? []).map((x) => ({
            ...summaryQuery(projectId, sessionId, x.generationId),
            ...READ_ONLY,
        })),
        combine: dataOf,
    });
    const liveSummary = useQuery({ ...liveSummaryQuery(projectId, sessionId), ...READ_ONLY }).data;
    const finalTranscript = gid ? final : undefined;
    return useMemo(
        () => ({ transcript, finalTranscripts, finalTranscript, summaryInfos, summaryTexts, liveSummary }),
        [transcript, finalTranscripts, finalTranscript, summaryInfos, summaryTexts, liveSummary],
    );
}

// 開いているセッション（中身を取っていれば中身も）
export function useCurrentSession(): Session | undefined {
    const project = useCurrentProject();
    const sessionId = useAppStore((s) => s.selection.sessionId);
    const row = project?.sessions.find((x) => x.id === sessionId);
    const local = useAppStore((s) => s.localSessions.some((x) => x.session.id === sessionId));
    const loaded = useAppStore((s) => (sessionId ? s.loadedSessions[sessionId] : undefined));
    const parts = useSessionParts(project?.id ?? '', row?.id ?? '', loaded?.finalTranscript);
    return useMemo(() => (row && !local ? sessionFrom(row, parts, loaded) : row), [row, local, parts, loaded]);
}
