import { queryOptions } from '@tanstack/react-query';

import { type SessionJson, api } from '@/api/api';
import { KEEP, displayTime } from '@/api/queryCommon';
import type { Session } from '@/api/types';
import { queryKeys } from '@/app/query';

function toSession(json: SessionJson): Session {
    return {
        id: json.id,
        uuid: json.uuid,
        title: json.title ?? '新しいセッション',
        uploaded: json.source === 'upload',
        startedAt: displayTime(json.startedAt) ?? '',
        endedAt: displayTime(json.endedAt),
        durationSec: json.durationSec ?? undefined,
        status: json.status,
        files: json.files,
        summaryFailed: json.summaryFailed ?? false,
        transcript: [],
        summaries: [],
    };
}

// プロジェクトのセッションの一覧（queryKeys.sessions()）。文字起こしと要約の中身は入らない（開いたときに取る）
export const sessionsQuery = (projectId: string) =>
    queryOptions({
        ...KEEP,
        queryKey: queryKeys.sessions(projectId),
        queryFn: async (): Promise<Session[]> =>
            (await api.get<SessionJson[]>(`/api/projects/${projectId}/sessions`)).map(toSession),
    });
