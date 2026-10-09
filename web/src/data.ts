// サーバーの REST API から、画面で使う形（types.ts）のデータを作る
import {
    type ProjectJson,
    type SessionJson,
    type SummaryInfoJson,
    type SummaryJson,
    type TranscriptJson,
    api,
} from '@/api';
import { formatDateTime } from '@/time';
import type { Project, Session, Summary } from '@/types';

// URL に ?demo を付けると、サーバーのデータではなく mock.ts のダミーデータを出す（説明用のスクリーンショットを撮るため）
export const isDemo = new URLSearchParams(location.search).has('demo');

// 日時（ISO 8601）を画面に出す形にする
function displayTime(iso: string | null | undefined) {
    return iso ? formatDateTime(new Date(iso)) : undefined;
}

function toSession(json: SessionJson): Session {
    return {
        id: json.id,
        title: json.title ?? '新しいセッション',
        startedAt: displayTime(json.startedAt) ?? '',
        endedAt: displayTime(json.endedAt),
        status: json.status,
        files: json.files,
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
            return { id: p.id, name: p.name, path: p.path, sessions: sessions.map(toSession) };
        }),
    );
}

// 前に取った文字起こしと要約は、同じセッションならそのまま使う（セッションを開くたびに取り直さないように）
export function mergeProjects(previous: Project[], next: Project[]): Project[] {
    const loaded = new Map(previous.flatMap((p) => p.sessions).map((s) => [s.id, s]));
    return next.map((p) => ({
        ...p,
        sessions: p.sessions.map((s) => {
            const old = loaded.get(s.id);
            // 録音中だったものや、ファイルの数が変わったものは取り直す
            if (!old?.loaded || old.status === 'recording' || old.files?.summaries !== s.files?.summaries) {
                return s;
            }
            return {
                ...s,
                loaded: true,
                transcript: old.transcript,
                summaries: old.summaries,
                liveSummary: old.liveSummary,
            };
        }),
    }));
}

// セッションの文字起こしと要約。ファイルが消えているもの（期限切れ）は取らない
export async function fetchSessionDetail(projectId: string, session: Session) {
    const base = `/api/projects/${projectId}/sessions/${session.id}`;
    const files = session.files;
    const transcript = files?.transcript ? (await api.get<TranscriptJson>(`${base}/transcript`)).lines : [];
    const infos = files?.summaries ? await api.get<SummaryInfoJson[]>(`${base}/summaries`) : [];
    const summaries: Summary[] = await Promise.all(
        infos.map(async (info) => {
            const json = await api.get<SummaryJson>(`${base}/summaries/${info.generationId}`);
            return {
                generationId: info.generationId,
                model: info.model,
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
    return { transcript, summaries, liveSummary };
}
