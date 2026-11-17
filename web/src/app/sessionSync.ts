// ストアのセッションを書き換えてキャッシュ（#330）にも入れる・サーバーから取り直す。
// WebSocket の通知と、画面の操作の両方から使う
import { toast } from 'sonner';

import type { CorrectionsJson } from '@/api/api';
import {
    fetchFinalTranscript,
    fetchFinalTranscripts,
    fetchSessionDetail,
    fetchTranscript,
    forgetTranscripts,
    isDemo,
    liveSummaryQuery,
    projectsQuery,
    sessionsQuery,
    transcriptQuery,
} from '@/api/data';
import type { Session } from '@/api/types';
import type { AppState, AppStore } from '@/app/appState';
import { queryClient } from '@/app/query';
import { sortSessions } from '@/features/projects/move';
import { sortByIds } from '@/features/projects/projectOrder';
import { updateSession } from '@/features/projects/updateSession';
import type { MetricsTracker } from '@/features/recording/metricsTracker';
import { mergeLiveLines } from '@/features/session/corrections';
import { keepLineSources, withLineSources } from '@/features/session/sources';
import { formatDateTime, newId } from '@/lib/time';

type TranscriptJson = Awaited<ReturnType<typeof fetchTranscript>>;

// デモ（?demo）ではサーバーに保存されないので、届いた最終の要約をそのままセッションに足す
function finishDemoSummary(s: AppState, sessionId: string): Partial<AppState> {
    if (s.generating?.sessionId !== sessionId) {
        return {};
    }
    const { model, text } = s.generating;
    const summary = { generationId: newId(), model, generatedAt: formatDateTime(), text };
    return {
        generating: null,
        projects: updateSession(s.projects, sessionId, (x) => ({ ...x, summaries: [...x.summaries, summary] })),
    };
}

// 取り直した文字起こしを、手元のセッションに入れる。gid は取り直した最終の文字起こしの世代
function withTranscript(
    x: Session,
    recording: boolean,
    json: TranscriptJson,
    finalTranscript: Session['finalTranscript'],
    gid: string | undefined,
): Session {
    return {
        ...x,
        // 録音中（この端末で録音しているセッション）は、行の数を手元のままにする
        transcript:
            recording && x.transcript
                ? mergeLiveLines(x.transcript, json.lines)
                : keepLineSources(withLineSources(json.lines, json.meta?.lineSources), x.transcript),
        pickedTerms: json.meta?.pickedTerms ?? x.pickedTerms,
        manualTerms: json.meta?.manualTerms ?? x.manualTerms,
        corrections: json.meta?.corrections ?? x.corrections,
        // 音源（#357）。録音を終えたら、録音中の一覧からフロントマターのもの（参加していた時間）に替える
        sources: (json.meta?.sources?.length ?? 0) >= 2 ? json.meta?.sources : x.sources,
        // 取り直している間に別の版に切り替えていたら、そのまま
        finalTranscript:
            finalTranscript && x.finalTranscript?.generationId === gid ? finalTranscript : x.finalTranscript,
    };
}

export class SessionSync {
    // 最終の要約ができて、サーバーに保存されたもので置き換えるセッション（取り直しで手元のものを残さない）
    releasing: string | null = null;
    // 最終の要約ができたので取り直しているセッション（title と status の両方から呼ばれても1回にする）
    private readonly reloadingSummaries = new Set<string>();
    // この画面から最終の文字起こしの作り直しを頼んだセッション（できたら、要約も作り直すかを聞く。#124）
    readonly regeneratingTranscripts = new Set<string>();

    private readonly store: AppStore;
    private readonly metrics: MetricsTracker;

    constructor(store: AppStore, metrics: MetricsTracker) {
        this.store = store;
        this.metrics = metrics;
    }

    findSession(sessionId: string) {
        return this.store
            .getState()
            .projects.flatMap((p) => p.sessions)
            .find((x) => x.id === sessionId);
    }

    private projectOf(sessionId: string) {
        return this.store.getState().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
    }

    // プロジェクトの並びが変わった。キャッシュのプロジェクトの一覧と画面の一覧を並べ直す（取り直さない）
    sortProjectsBy = (ids: string[]) => {
        queryClient.setQueryData(projectsQuery.queryKey, (list) => list && sortByIds(list, ids));
        this.store.setState((s) => ({ projects: sortByIds(s.projects, ids) }));
    };

    // WebSocket の通知・操作でストアのセッションを書き換えたあとに呼び、サーバーのデータにあたる部分を
    // キャッシュにも入れる（取り直さない）。キャッシュにまだないもの（取っていない文字起こしなど）は作らない
    syncSessionToCache = (sessionId: string) => {
        const pid = this.projectOf(sessionId)?.id;
        const session = this.findSession(sessionId);
        if (!pid || !session) {
            return;
        }
        // セッションの一覧（一覧に出す項目）
        const { title, status, files, summaryFailed } = session;
        queryClient.setQueryData(sessionsQuery(pid).queryKey, (list) =>
            list?.map((x) => (x.id === sessionId ? { ...x, title, status, files, summaryFailed } : x)),
        );
        // 文字起こし（行と、拾った語・手で足した語・置き換え）
        queryClient.setQueryData(
            transcriptQuery(pid, sessionId).queryKey,
            (t) =>
                t && {
                    lines: session.loaded ? session.transcript : t.lines,
                    meta: {
                        ...t.meta,
                        pickedTerms: session.pickedTerms ?? t.meta?.pickedTerms,
                        manualTerms: session.manualTerms ?? t.meta?.manualTerms,
                        corrections: session.corrections ?? t.meta?.corrections,
                    },
                },
        );
        // 途中の要約
        if (session.liveSummary !== undefined) {
            queryClient.setQueryData(liveSummaryQuery(pid, sessionId).queryKey, {
                kind: 'live',
                text: session.liveSummary,
            });
        }
    };

    // セッションを画面とキャッシュの上で別のプロジェクトへ移す（サーバーには送らない）。開いていたら、移した先で開いたままにする
    moveLocally(sessionId: string, fromId: string, toId: string) {
        const session = this.store
            .getState()
            .projects.find((p) => p.id === fromId)
            ?.sessions.find((x) => x.id === sessionId);
        if (!session) {
            return;
        }
        this.store.setState((s) => ({
            projects: s.projects.map((p) =>
                p.id === fromId
                    ? { ...p, sessions: p.sessions.filter((x) => x.id !== sessionId) }
                    : p.id === toId
                      ? { ...p, sessions: sortSessions([...p.sessions, session]) }
                      : p,
            ),
            selection:
                s.selection.sessionId === sessionId && s.selection.projectId === fromId
                    ? { projectId: toId, sessionId }
                    : s.selection,
        }));
        const cached = queryClient.getQueryData(sessionsQuery(fromId).queryKey)?.find((x) => x.id === sessionId);
        queryClient.setQueryData(sessionsQuery(fromId).queryKey, (list) => list?.filter((x) => x.id !== sessionId));
        if (cached) {
            queryClient.setQueryData(sessionsQuery(toId).queryKey, (list) => list && sortSessions([...list, cached]));
        }
    }

    // ストアのセッションを書き換えて、キャッシュにも入れる
    patchSession = (sessionId: string, change: (session: Session) => Session) => {
        this.store.setState((s) => ({ projects: updateSession(s.projects, sessionId, change) }));
        this.syncSessionToCache(sessionId);
    };

    // 置き換え（#176）を足した・外したときの返事を、セッションに入れる
    receiveCorrections(sessionId: string, res: CorrectionsJson) {
        this.patchSession(sessionId, (x) => ({
            ...x,
            pickedTerms: res.pickedTerms,
            manualTerms: res.manualTerms ?? x.manualTerms,
            corrections: res.corrections,
        }));
    }

    // 最終の要約ができたら、一覧とセッションの中身をサーバーから取り直す
    reloadAfterFinalSummary = async (sessionId: string) => {
        // まだ送っていなければ、最終の要約ができたか分からないまま外れたもの（成功は title で送り済み）。#206
        this.metrics.finish(sessionId, false);
        if (isDemo) {
            this.store.setState((s) => finishDemoSummary(s, sessionId));
            return;
        }
        if (this.reloadingSummaries.has(sessionId)) {
            return;
        }
        this.reloadingSummaries.add(sessionId);
        try {
            await this.reloadReleased(sessionId);
            this.store.setState((s) => ({ generating: s.generating?.sessionId === sessionId ? null : s.generating }));
        } finally {
            this.reloadingSummaries.delete(sessionId);
        }
    };

    // 手元で積み上げたものを捨てて、サーバーに保存されたもので置き換える
    private async reloadReleased(sessionId: string) {
        this.releasing = sessionId;
        try {
            await this.store.getState().loadProjects();
        } finally {
            this.releasing = null;
        }
        const project = this.projectOf(sessionId);
        const session = this.findSession(sessionId);
        if (project && session && !session.loaded) {
            await this.loadSession(project.id, session);
        } else if (session?.sources === undefined && this.store.getState().liveSources[sessionId]) {
            // 音源が 2 つ以上の録音を終えた（#357）。録音中の音源の一覧を、フロントマターのもの（参加していた時間・
            // 行ごとの音源）に替える
            await this.refreshTranscripts(sessionId);
        }
    }

    // 最終の文字起こしができた（作り直した）。できた世代を出す
    receiveFinalTranscript = async (sessionId: string, gid: string) => {
        const requested = this.regeneratingTranscripts.delete(sessionId);
        const project = this.projectOf(sessionId);
        if (!project) {
            // まだ一覧にない（ほかの端末のセッションなど）
            void this.store.getState().loadProjects();
            return;
        }
        try {
            const [finalTranscripts, finalTranscript] = await Promise.all([
                fetchFinalTranscripts(project.id, sessionId),
                fetchFinalTranscript(project.id, sessionId, gid),
            ]);
            this.patchSession(sessionId, (x) => ({
                ...x,
                finalTranscript,
                finalTranscripts,
                files: x.files && { ...x.files, finalTranscripts: finalTranscripts.length },
            }));
        } catch {
            // 取れなければ、次に一覧を取り直したときに出る
            return;
        }
        if (requested) {
            // 要約は勝手に作り直さず、聞くだけにする（#124）
            toast.success('浄書済み文字起こしを再生成しました', {
                duration: 15000,
                action: {
                    label: '要約も再生成する',
                    onClick: () => void this.store.getState().regenerateSummary(sessionId),
                },
            });
        }
    };

    // セッションを別のプロジェクトへ移したあと、一覧を取り直す。開いていたら、移した先で開いたままにする
    reloadAfterMove = async (sessionId: string, from: string, to: string) => {
        // 元のプロジェクトの下のキャッシュ（文字起こし・要約など）は、もう使わない
        queryClient.removeQueries({ queryKey: [...sessionsQuery(from).queryKey, sessionId] });
        await this.store.getState().loadProjects();
        const { selection, selectSession } = this.store.getState();
        if (selection.sessionId === sessionId && selection.projectId === from) {
            selectSession(to, sessionId);
        }
    };

    // 置き換えたあと（ほかの端末で置き換えたときも）、読み込み済みのセッションの文字起こし
    // （リアルタイムと、いま出している浄書済みの版）と置き換えの一覧を取り直す
    refreshTranscripts = async (sessionId: string) => {
        const project = this.projectOf(sessionId);
        if (!project) {
            return;
        }
        // キャッシュにある文字起こしと最終の文字起こしの世代は、置き換える前のもの
        await forgetTranscripts(project.id, sessionId);
        // 待っている間に、世代を切り替えた・読み込み終えたかもしれないので、読み直す
        const session = this.findSession(sessionId);
        if (!session?.loaded) {
            return;
        }
        const gid = session.finalTranscript?.generationId;
        try {
            const [json, finalTranscript] = await Promise.all([
                fetchTranscript(project.id, sessionId),
                gid ? fetchFinalTranscript(project.id, sessionId, gid) : Promise.resolve(undefined),
            ]);
            this.store.setState((s) => ({
                projects: updateSession(s.projects, sessionId, (x) =>
                    withTranscript(x, s.recordingSessionId === sessionId, json, finalTranscript, gid),
                ),
            }));
            this.syncSessionToCache(sessionId);
        } catch {
            // 取れなければ、次に開いたときに出る
        }
    };

    // セッションの文字起こしと要約を取ってくる（開いたとき）
    async loadSession(projectId: string, session: Session) {
        const set = this.store.setState;
        try {
            const detail = await fetchSessionDetail(projectId, session, this.store.getState().settings.whisper.model);
            set((s) => ({
                projects: updateSession(s.projects, session.id, (x) => ({ ...x, ...detail, loaded: true })),
            }));
        } catch (e) {
            toast.error(`セッションを読み込めません: ${(e as Error).message}`);
            // 「読み込んでいます…」のままにしない
            set((s) => ({ projects: updateSession(s.projects, session.id, (x) => ({ ...x, loaded: true })) }));
        }
    }
}
