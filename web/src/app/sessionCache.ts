// セッションの中身をキャッシュ（#330）から読む・書き戻す（#361）。サーバーのデータはキャッシュにだけ持つ
import {
    KEEP,
    finalTranscriptQuery,
    finalTranscriptsQuery,
    liveSummaryQuery,
    sessionsQuery,
    summariesQuery,
    summaryQuery,
    transcriptQuery,
} from '@/api/data';
import type { Session } from '@/api/types';
import { queryClient, queryKeys } from '@/app/query';
import type { SessionParts } from '@/features/session/sessionDetail';

// 一覧に出す項目（GET .../sessions の 1 行にあたるもの）
const ROW_KEYS = [
    'uuid',
    'title',
    'provisionalTitle',
    'status',
    'endedAt',
    'durationSec',
    'files',
    'summaryFailed',
] as const;

// 中身をキャッシュに直接入れるときも、取ったものと同じく捨てない設定（KEEP）で作る
function keep<T extends readonly unknown[]>(queryKey: T): T {
    queryClient.getQueryCache().build(queryClient, { ...KEEP, queryKey });
    return queryKey;
}

export function cachedParts(projectId: string, sessionId: string, gid: string | undefined): SessionParts {
    const summaryInfos = queryClient.getQueryData(summariesQuery(projectId, sessionId).queryKey);
    return {
        transcript: queryClient.getQueryData(transcriptQuery(projectId, sessionId).queryKey),
        finalTranscripts: queryClient.getQueryData(finalTranscriptsQuery(projectId, sessionId).queryKey),
        finalTranscript: gid
            ? queryClient.getQueryData(finalTranscriptQuery(projectId, sessionId, gid).queryKey)
            : undefined,
        summaryInfos,
        summaryTexts: (summaryInfos ?? []).map((info) =>
            queryClient.getQueryData(summaryQuery(projectId, sessionId, info.generationId).queryKey),
        ),
        liveSummary: queryClient.getQueryData(liveSummaryQuery(projectId, sessionId).queryKey),
    };
}

function writeRow(projectId: string, before: Session, after: Session) {
    if (ROW_KEYS.every((k) => before[k] === after[k])) {
        return;
    }
    const row = Object.fromEntries(ROW_KEYS.map((k) => [k, after[k]]));
    queryClient.setQueryData(sessionsQuery(projectId).queryKey, (list) =>
        list?.map((x) => (x.id === after.id ? { ...x, ...row } : x)),
    );
}

// 行を書き換えたら、行ごとの音源（lineSources）は行のほうに入っているので、meta からは外す
function writeTranscript(projectId: string, before: Session, after: Session) {
    const lines = before.transcript !== after.transcript;
    const terms =
        before.pickedTerms !== after.pickedTerms ||
        before.manualTerms !== after.manualTerms ||
        before.corrections !== after.corrections;
    if (!lines && !terms) {
        return;
    }
    queryClient.setQueryData(keep(transcriptQuery(projectId, after.id).queryKey), (t) => {
        const { lineSources, ...rest } = t?.meta ?? {};
        return {
            lines: lines ? after.transcript : (t?.lines ?? []),
            meta: {
                ...rest,
                ...(lines ? {} : { lineSources }),
                pickedTerms: after.pickedTerms,
                manualTerms: after.manualTerms,
                corrections: after.corrections,
            },
        };
    });
}

// セッションを書き換えた結果のうち、サーバーのデータにあたる部分をキャッシュに書き戻す
export function writeSessionToCache(projectId: string, before: Session, after: Session) {
    writeRow(projectId, before, after);
    writeTranscript(projectId, before, after);
    const sid = after.id;
    if (after.finalTranscripts && after.finalTranscripts !== before.finalTranscripts) {
        queryClient.setQueryData(keep(finalTranscriptsQuery(projectId, sid).queryKey), after.finalTranscripts);
    }
    const final = after.finalTranscript;
    if (final && final !== before.finalTranscript) {
        queryClient.setQueryData(keep(finalTranscriptQuery(projectId, sid, final.generationId).queryKey), final);
    }
    if (after.liveSummary !== undefined && after.liveSummary !== before.liveSummary) {
        queryClient.setQueryData(keep(liveSummaryQuery(projectId, sid).queryKey), {
            kind: 'live',
            text: after.liveSummary,
        });
    }
}

// セッションを別のプロジェクトへ移した。そのセッションの下のキャッシュ（文字起こし・要約など）を移す
export function moveSessionCache(sessionId: string, fromId: string, toId: string) {
    const prefix = [...queryKeys.sessions(fromId), sessionId];
    for (const q of queryClient.getQueryCache().findAll({ queryKey: prefix })) {
        if (q.state.data !== undefined) {
            const rest = q.queryKey.slice(prefix.length);
            queryClient.setQueryData(keep([...queryKeys.sessions(toId), sessionId, ...rest]), q.state.data);
        }
    }
    queryClient.removeQueries({ queryKey: prefix });
}
