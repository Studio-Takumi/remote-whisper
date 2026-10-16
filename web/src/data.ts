// サーバーの REST API から、画面で使う形（types.ts）のデータを作る
import {
    type FinalTranscriptJson,
    type ProjectJson,
    type SessionJson,
    type SummaryInfoJson,
    type SummaryJson,
    type TranscriptJson,
    api,
} from '@/api';
import { formatDateTime } from '@/time';
import type {
    ContextSelection,
    ContextSet,
    FinalTranscript,
    FinalTranscriptInfo,
    Project,
    Session,
    Summary,
} from '@/types';

// URL に ?demo を付けると、サーバーのデータではなく mock.ts のダミーデータを出す（説明用のスクリーンショットを撮るため）
export const isDemo = new URLSearchParams(location.search).has('demo');

// 日時（ISO 8601）を画面に出す形にする
function displayTime(iso: string | null | undefined) {
    return iso ? formatDateTime(new Date(iso)) : undefined;
}

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

// プロジェクトの一覧と、それぞれのセッションの一覧（文字起こしと要約の中身は、開いたときに取る）
export async function fetchProjects(): Promise<Project[]> {
    const projects = await api.get<ProjectJson[]>('/api/projects');
    return Promise.all(
        projects.map(async (p) => {
            const sessions = await api.get<SessionJson[]>(`/api/projects/${p.id}/sessions`);
            return {
                id: p.id,
                uuid: p.uuid,
                name: p.name,
                path: p.path,
                sessions: sessions.map(toSession),
                selection: toSelection(p.selection),
            };
        }),
    );
}

export function toSelection(json: ProjectJson['selection']): ContextSelection {
    return {
        setId: json.contextSet,
        useHotwords: json.useHotwords,
        useContext: json.useContext,
        pickTerms: json.pickTerms ?? true,
    };
}

// プロジェクトの参考資料セットの一覧
export async function fetchContextSets(projectId: string): Promise<ContextSet[]> {
    return api.get<ContextSet[]>(`/api/projects/${projectId}/context-sets`);
}

// 前に取った文字起こしと要約は、同じセッションならそのまま使う（セッションを開くたびに取り直さないように）
// keep は、手元で中身を積み上げているセッション（自分が録音中・最終の要約を待っているもの）。
// それらは手元の中身を残し、サーバーの一覧にまだなければ手元のものを足す
export function mergeProjects(previous: Project[], next: Project[], keep: Set<string>): Project[] {
    const loaded = new Map(previous.flatMap((p) => p.sessions).map((s) => [s.id, s]));
    return next.map((p) => {
        const kept = previous
            .find((q) => q.id === p.id)
            ?.sessions.filter((s) => keep.has(s.id) && !p.sessions.some((x) => x.id === s.id));
        return { ...p, sessions: [...(kept ?? []), ...p.sessions.map((s) => mergeSession(loaded.get(s.id), s, keep))] };
    });
}

function mergeSession(old: Session | undefined, s: Session, keep: Set<string>): Session {
    // 手元で積み上げているものは、手元のまま
    if (old && keep.has(s.id)) {
        return old;
    }
    // 録音中だったものや、ファイルが増えた・消えたものは取り直す
    if (
        !old?.loaded ||
        old.status === 'recording' ||
        old.files?.summaries !== s.files?.summaries ||
        old.files?.transcript !== s.files?.transcript ||
        old.files?.finalTranscripts !== s.files?.finalTranscripts
    ) {
        return s;
    }
    return {
        ...s,
        loaded: true,
        transcript: old.transcript,
        finalTranscript: old.finalTranscript,
        finalTranscripts: old.finalTranscripts,
        summaries: old.summaries,
        liveSummary: old.liveSummary,
    };
}

// 最終の文字起こし（#121）の 1 つの世代。gid を省くといちばん新しいもの
export async function fetchFinalTranscript(
    projectId: string,
    sessionId: string,
    gid = 'latest',
): Promise<FinalTranscript> {
    const json = await api.get<FinalTranscriptJson>(
        `/api/projects/${projectId}/sessions/${sessionId}/final-transcripts/${gid}`,
    );
    return { ...json.meta, generatedAt: displayTime(json.meta.generatedAt) ?? '', lines: json.lines };
}

// 最終の文字起こしの世代の一覧（#124。古いものから）
export async function fetchFinalTranscripts(projectId: string, sessionId: string): Promise<FinalTranscriptInfo[]> {
    const list = await api.get<FinalTranscriptJson['meta'][]>(
        `/api/projects/${projectId}/sessions/${sessionId}/final-transcripts`,
    );
    return list.map((m) => ({ ...m, generatedAt: displayTime(m.generatedAt) ?? '' }));
}

// 表示する最終の文字起こしの世代。今の全体設定の Whisper のモデルで作ったうちいちばん新しいもの。
// そのモデルのものがなければ、モデルを問わずいちばん新しいもの（要約と同じ。spec 6.5）
export function pickFinalTranscript(infos: FinalTranscriptInfo[], model: string) {
    return infos.findLast((x) => x.model === model) ?? infos.at(-1);
}

// セッションの文字起こしと要約。ファイルが消えているもの（期限切れ）は取らない
// whisperModel は今の全体設定の Whisper のモデル（表示する最終の文字起こしの世代を選ぶ）
export async function fetchSessionDetail(projectId: string, session: Session, whisperModel = '') {
    const base = `/api/projects/${projectId}/sessions/${session.id}`;
    // どのファイルがあるか分からない（手元で作ったセッション）ときは、先にサーバーに聞く
    const files = session.files ?? (await api.get<SessionJson>(base)).files;
    const transcriptJson = files?.transcript ? await api.get<TranscriptJson>(`${base}/transcript`) : null;
    const transcript = transcriptJson?.lines ?? [];
    const pickedTerms = transcriptJson?.meta?.pickedTerms ?? [];
    const materialRange = transcriptJson?.meta?.materialRange ?? undefined;
    // 取れなくても（消えた直後など）、録音中の文字起こしと要約は出す
    const finalTranscripts = files?.finalTranscripts
        ? await fetchFinalTranscripts(projectId, session.id).catch(() => undefined)
        : undefined;
    const picked = finalTranscripts && pickFinalTranscript(finalTranscripts, whisperModel);
    const finalTranscript = picked
        ? await fetchFinalTranscript(projectId, session.id, picked.generationId).catch(() => undefined)
        : undefined;
    const infos = files?.summaries ? await api.get<SummaryInfoJson[]>(`${base}/summaries`) : [];
    const summaries: Summary[] = await Promise.all(
        infos.map(async (info) => {
            const json = await api.get<SummaryJson>(`${base}/summaries/${info.generationId}`);
            return {
                generationId: info.generationId,
                model: info.model,
                overviewModel: info.overviewModel ?? info.model,
                generatedAt: displayTime(info.generatedAt) ?? '',
                text: json.text,
            };
        }),
    );
    // 最終の要約がまだなければ、途中の要約を代わりに出す
    let liveSummary: string | undefined;
    if (summaries.length === 0 && files?.liveSummary) {
        const json = await api.get<SummaryJson>(`${base}/summaries/latest`);
        liveSummary = json.kind === 'live' ? json.text : undefined;
    }
    return {
        files,
        transcript,
        finalTranscript,
        finalTranscripts,
        summaries,
        liveSummary,
        pickedTerms,
        materialRange,
    };
}
