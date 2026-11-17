import { type SessionJson, api } from '@/api/api';
import { liveSummaryQuery, summariesQuery, summaryQuery } from '@/api/summaries';
import { fetchFinalTranscript, fetchFinalTranscripts, fetchTranscript, pickFinalTranscript } from '@/api/transcripts';
import type { Session } from '@/api/types';
import { queryClient, queryKeys } from '@/app/query';

// キャッシュから消す（ファイルがないものを、前に取ったもので出さないように）
function forget(queryKey: readonly unknown[]) {
    queryClient.removeQueries({ queryKey, exact: true });
}

// セッションの文字起こしと要約をキャッシュに入れる。ファイルが消えているもの（期限切れ）は取らずに消す。
// whisperModel は今の全体設定の Whisper のモデル。どのファイルがあるかと、出す最終の文字起こしの世代を返す
export async function loadSessionDetail(projectId: string, session: Session, whisperModel = '') {
    const sid = session.id;
    // どのファイルがあるか分からない（手元で作ったセッション）ときは、先にサーバーに聞く
    const files = session.files ?? (await api.get<SessionJson>(`/api/projects/${projectId}/sessions/${sid}`)).files;
    if (files?.transcript) {
        await fetchTranscript(projectId, sid);
    } else {
        forget(queryKeys.transcript(projectId, sid));
    }
    // 取れなくても（消えた直後など）、録音中の文字起こしと要約は出す
    const finalTranscripts = files?.finalTranscripts
        ? await fetchFinalTranscripts(projectId, sid).catch(() => undefined)
        : undefined;
    const picked = finalTranscripts && pickFinalTranscript(finalTranscripts, whisperModel);
    if (picked) {
        await fetchFinalTranscript(projectId, sid, picked.generationId).catch(() => undefined);
    }
    const infos = files?.summaries
        ? await queryClient.fetchQuery({ ...summariesQuery(projectId, sid), staleTime: 0 })
        : [];
    if (!files?.summaries) {
        forget(queryKeys.summaries(projectId, sid));
    }
    await Promise.all(infos.map((info) => queryClient.fetchQuery(summaryQuery(projectId, sid, info.generationId))));
    // 最終の要約がまだなければ、途中の要約を代わりに出す
    if (infos.length === 0 && files?.liveSummary) {
        await queryClient.fetchQuery(liveSummaryQuery(projectId, sid));
    } else {
        forget(liveSummaryQuery(projectId, sid).queryKey);
    }
    return { files, finalTranscript: picked?.generationId };
}
