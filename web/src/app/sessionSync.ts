// セッションを書き換える・サーバーから取り直す。WebSocket の通知と、画面の操作の両方から使う。
// サーバーのデータはキャッシュに、手元で積み上げているセッションはストアに入れる（#361）
import { toast } from 'sonner';

import type { CorrectionsJson, SessionFiles, TranscriptJson } from '@/api/api';
import { isDemo } from '@/api/demo';
import { loadSessionDetail } from '@/api/loadSessionDetail';
import { projectsQuery } from '@/api/projects';
import { sessionsQuery } from '@/api/sessions';
import {
    fetchFinalTranscript,
    fetchFinalTranscripts,
    fetchTranscript,
    finalTranscriptQuery,
    forgetTranscripts,
} from '@/api/transcripts';
import type { Session } from '@/api/types';
import type { AppState, AppStore } from '@/app/appState';
import { queryClient, queryKeys } from '@/app/query';
import { cachedParts, moveSessionCache } from '@/app/sessionCache';
import { patchSessionData, projectIdOf, readSession, setLoaded } from '@/app/sessionData';
import { findLocal, patchLocal } from '@/features/projects/localSessions';
import { sortSessions } from '@/features/projects/move';
import { sortByIds } from '@/features/projects/projectOrder';
import type { MetricsTracker } from '@/features/recording/metricsTracker';
import { mergeLiveLines } from '@/features/session/corrections';
import { type LoadedSession, applyDetail } from '@/features/session/sessionDetail';
import { keepLineSources, withLineSources } from '@/features/session/sources';
import { formatDateTime, newId } from '@/lib/time';

// デモ（?demo）ではサーバーに保存されないので、届いた最終の要約をそのままセッションに足す
function finishDemoSummary(s: AppState, sessionId: string): Partial<AppState> {
    if (s.generating?.sessionId !== sessionId) {
        return {};
    }
    const { model, text } = s.generating;
    const summary = { generationId: newId(), model, generatedAt: formatDateTime(), text };
    return {
        generating: null,
        localSessions: patchLocal(s.localSessions, sessionId, (x) => ({ ...x, summaries: [...x.summaries, summary] })),
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
    private releasing: string | null = null;
    // 最終の要約ができたので取り直しているセッション（title と status の両方から呼ばれても1回にする）
    private readonly reloadingSummaries = new Set<string>();
    // この画面から最終の文字起こしの作り直しを頼んだセッション（できたら、要約も作り直すかを聞く。#124）
    private readonly regeneratingTranscripts = new Set<string>();

    private readonly store: AppStore;
    private readonly metrics: MetricsTracker;

    constructor(store: AppStore, metrics: MetricsTracker) {
        this.store = store;
        this.metrics = metrics;
    }

    findSession(sessionId: string) {
        return readSession(this.store.getState(), sessionId);
    }

    projectIdOf(sessionId: string) {
        return projectIdOf(this.store.getState(), sessionId);
    }

    // 取り直しで、手元のものを残さずにサーバーのもので置き換えている途中か
    isReleasing(sessionId: string) {
        return this.releasing === sessionId;
    }

    // 最終の文字起こしの作り直しを頼んだ・頼めなかった（返事より先に結果が届くこともあるので、頼む前に覚える）
    expectFinalTranscript(sessionId: string) {
        this.regeneratingTranscripts.add(sessionId);
    }

    forgetFinalTranscript(sessionId: string) {
        this.regeneratingTranscripts.delete(sessionId);
    }

    // プロジェクトの並びが変わった。キャッシュのプロジェクトの一覧を並べ直す（取り直さない）
    sortProjectsBy = (ids: string[]) => {
        queryClient.setQueryData(projectsQuery.queryKey, (list) => list && sortByIds(list, ids));
    };

    // セッションを画面とキャッシュの上で別のプロジェクトへ移す（サーバーには送らない）。開いていたら、移した先で開いたままにする
    moveLocally(sessionId: string, fromId: string, toId: string) {
        const row = queryClient.getQueryData(sessionsQuery(fromId).queryKey)?.find((x) => x.id === sessionId);
        const local = findLocal(this.store.getState().localSessions, sessionId);
        if (!row && local?.projectId !== fromId) {
            return;
        }
        queryClient.setQueryData(sessionsQuery(fromId).queryKey, (list) => list?.filter((x) => x.id !== sessionId));
        if (row) {
            queryClient.setQueryData(sessionsQuery(toId).queryKey, (list) => list && sortSessions([...list, row]));
        }
        moveSessionCache(sessionId, fromId, toId);
        this.store.setState((s) => ({
            localSessions: s.localSessions.map((x) => (x.session.id === sessionId ? { ...x, projectId: toId } : x)),
            selection:
                s.selection.sessionId === sessionId && s.selection.projectId === fromId
                    ? { projectId: toId, sessionId }
                    : s.selection,
        }));
    }

    // セッションを書き換える（手元のセッションはストア、それ以外はキャッシュ）
    patchSession = (sessionId: string, change: (session: Session) => Session) => {
        patchSessionData(this.store, sessionId, change);
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
        const pid = this.projectIdOf(sessionId);
        const session = this.findSession(sessionId);
        if (pid && session && !session.loaded) {
            await this.loadSession(pid, session);
        } else if (session?.sources === undefined && this.store.getState().liveSources[sessionId]) {
            // 音源が 2 つ以上の録音を終えた（#357）。録音中の音源の一覧を、フロントマターのもの（参加していた時間・
            // 行ごとの音源）に替える
            await this.refreshTranscripts(sessionId);
        }
    }

    // 最終の文字起こしができた（作り直した）。できた世代を出す
    receiveFinalTranscript = async (sessionId: string, gid: string) => {
        const requested = this.regeneratingTranscripts.delete(sessionId);
        const pid = this.projectIdOf(sessionId);
        if (!pid) {
            // まだ一覧にない（ほかの端末のセッションなど）
            void this.store.getState().loadProjects();
            return;
        }
        try {
            const [finalTranscripts, finalTranscript] = await Promise.all([
                fetchFinalTranscripts(pid, sessionId),
                fetchFinalTranscript(pid, sessionId, gid),
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
        const pid = this.projectIdOf(sessionId);
        if (!pid) {
            return;
        }
        // キャッシュにある文字起こしと最終の文字起こしの世代は、置き換える前のもの。出しているものは消さずに取り直す
        const shown = this.findSession(sessionId);
        const shownGid = shown?.finalTranscript?.generationId;
        const keep = shown?.loaded
            ? [
                  queryKeys.transcript(pid, sessionId),
                  queryKeys.finalTranscripts(pid, sessionId),
                  ...(shownGid ? [queryKeys.finalTranscript(pid, sessionId, shownGid)] : []),
              ]
            : [];
        await forgetTranscripts(pid, sessionId, keep);
        // 待っている間に、世代を切り替えた・読み込み終えたかもしれないので、読み直す
        const session = this.findSession(sessionId);
        if (!session?.loaded) {
            return;
        }
        const gid = session.finalTranscript?.generationId;
        try {
            const [json, finalTranscript] = await Promise.all([
                fetchTranscript(pid, sessionId),
                gid
                    ? queryClient.fetchQuery({ ...finalTranscriptQuery(pid, sessionId, gid), staleTime: 0 })
                    : Promise.resolve(undefined),
            ]);
            this.receiveTranscript(sessionId, session, json, finalTranscript, gid);
        } catch {
            // 取れなければ、次に開いたときに出る
        }
    };

    // 取り直した文字起こしを入れる。キャッシュのセッションはもう入っているので、取り直す前の行の音源だけ残す
    private receiveTranscript(
        sessionId: string,
        before: Session,
        json: TranscriptJson,
        finalTranscript: Session['finalTranscript'],
        gid: string | undefined,
    ) {
        if (findLocal(this.store.getState().localSessions, sessionId)) {
            this.store.setState((s) => ({
                localSessions: patchLocal(s.localSessions, sessionId, (x) =>
                    withTranscript(x, s.recordingSessionId === sessionId, json, finalTranscript, gid),
                ),
            }));
            return;
        }
        this.patchSession(sessionId, (x) => ({ ...x, transcript: keepLineSources(x.transcript, before.transcript) }));
    }

    // セッションの文字起こしと要約を取ってくる（開いたとき）
    async loadSession(projectId: string, session: Session) {
        try {
            const whisper = this.store.getState().settings.whisper.model;
            const { files, finalTranscript } = await loadSessionDetail(projectId, session, whisper);
            this.markLoaded(projectId, session.id, files, { finalTranscript });
        } catch (e) {
            toast.error(`セッションを読み込めません: ${(e as Error).message}`);
            // 「読み込んでいます…」のままにしない
            this.markLoaded(projectId, session.id, undefined, { failed: true });
        }
    }

    // 手元のセッションは取った中身を入れ、キャッシュのセッションは取ったことを覚える
    private markLoaded(projectId: string, sessionId: string, files: SessionFiles | undefined, loaded: LoadedSession) {
        if (!findLocal(this.store.getState().localSessions, sessionId)) {
            setLoaded(this.store, sessionId, loaded);
            return;
        }
        const parts = cachedParts(projectId, sessionId, loaded.finalTranscript);
        this.store.setState((s) => ({
            localSessions: patchLocal(s.localSessions, sessionId, (x) =>
                loaded.failed ? { ...x, loaded: true } : applyDetail({ ...x, files: files ?? x.files }, parts),
            ),
        }));
    }
}
