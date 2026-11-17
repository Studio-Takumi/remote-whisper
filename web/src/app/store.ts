import { toast } from 'sonner';
import { create } from 'zustand';

import { ApiError, type CorrectionsJson, type ProjectJson, type TermsJson, api } from '@/api/api';
import { connection } from '@/api/connection';
import {
    contextSetsQuery,
    fetchFinalTranscript,
    fetchFinalTranscripts,
    fetchProjects,
    fetchSessionDetail,
    fetchTranscript,
    forgetTranscripts,
    isDemo,
    liveSummaryQuery,
    mergeProjects,
    projectsQuery,
    sessionsQuery,
    toSelection,
    transcriptQuery,
} from '@/api/data';
import { demoProjects, fallbackOptions, initialContextSets } from '@/api/mock';
import { initialServerStatus } from '@/api/status';
import type { ContextSelection, ContextSet, Project, Session } from '@/api/types';
import type { AppState } from '@/app/appState';
import { queryClient, runMutation } from '@/app/query';
import { connectServer } from '@/app/serverConnection';
import { StatusReceiver } from '@/app/serverStatus';
import type { VersionJson } from '@/app/version';
import { sortSessions } from '@/features/projects/move';
import { sortByIds } from '@/features/projects/projectOrder';
import { updateSession } from '@/features/projects/updateSession';
import { watchMicrophonePermission } from '@/features/recording/audio/microphone';
import { keepScreenOn, screenKeptOn } from '@/features/recording/audio/wakeLock';
import {
    continueRecording,
    pauseRecording,
    reopenMicrophone,
    startNew,
    stopRecording,
    unpauseRecording,
} from '@/features/recording/recorder';
import { createRecorder } from '@/features/recording/recorderState';
import { recordingLocks } from '@/features/recording/recording';
import { discardUnsent, discardUnsentElsewhere, recoverUnsent } from '@/features/recording/unsentRecovery';
import { UploadError, uploadAudio, uploadSource } from '@/features/recording/upload';
import { Watcher } from '@/features/recording/watcher';
import { type Correction, applyCorrectionLocally, mergeLiveLines } from '@/features/session/corrections';
import { keepLineSources, withLineSources } from '@/features/session/sources';
import { fetchOptions } from '@/features/settings/options';
import {
    type OllamaModels,
    SETTINGS_PAGES,
    type Settings,
    defaultSettings,
    finalModelLabel,
    isCurrentFinalSummary,
    llmBackend,
    llmModels,
} from '@/features/settings/settings';
import { formatDateTime, newId } from '@/lib/time';

// 画面の状態をまとめて持つストア。プロジェクト・セッション・設定はサーバーの API から取る（spec/api.md 7.1）

export type { LivePartial } from '@/features/session/livePartials';

// 選択中のものを取り出すセレクタ。毎回同じ参照を返すように、空のときも定数を返す
const NO_PROJECTS: Project[] = [];
const NO_SETS: ContextSet[] = [];

export const visibleProjects = (s: AppState) => (s.noProjects ? NO_PROJECTS : s.projects);
export const currentProject = (s: AppState) => visibleProjects(s).find((p) => p.id === s.selection.projectId);
export const currentSession = (s: AppState) => currentProject(s)?.sessions.find((x) => x.id === s.selection.sessionId);

// 録音を終えていて文字起こしがあるのに、そのモデルの最終の要約がまだないか（作り直すかどうか）
export function needsSummaryFor(session: Session, models: OllamaModels) {
    return (
        session.loaded === true &&
        session.status !== 'recording' &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        !session.summaries.some((x) => isCurrentFinalSummary(x, models))
    );
}
// プロジェクトの参考資料セットの一覧。サーバーのデータなのでストアには持たず、キャッシュ（#330）から読む。
// 画面からは useCurrentContextSets（features/materials/useContextSets.ts）で読む
export function cachedContextSets(projectId: string | undefined) {
    return (projectId && queryClient.getQueryData(contextSetsQuery(projectId).queryKey)) || NO_SETS;
}

function updateCachedContextSets(projectId: string, change: (sets: ContextSet[]) => ContextSet[]) {
    queryClient.setQueryData(contextSetsQuery(projectId).queryKey, (sets) => change(sets ?? NO_SETS));
}

// 開いているプロジェクトで使う参考資料セットの選択。sets はそのプロジェクトの参考資料セットの一覧。
// 新しいオブジェクトを返すことがあるので、使うときは useShallow で包む
export const currentContextSelection = (s: AppState, sets: ContextSet[]): ContextSelection => {
    const project = currentProject(s);
    // 手元で変えたもの → サーバーに保存されているもの → 既定（ready のうち最初に作ったもの）
    return (
        (project && (s.contextSelections[project.id] ?? project.selection)) ?? {
            setId: sets.find((x) => x.status === 'ready')?.id ?? null,
            useHotwords: true,
            useContext: true,
            pickTerms: true,
        }
    );
};

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

export const useAppStore = create<AppState>()((set, get, store) => {
    const recorder = createRecorder(store);
    const { metrics } = recorder;
    // 開発中は、マイクが止まったときの動きを確かめられるようにする（#102）
    if (import.meta.env.DEV) {
        Object.assign(window, { appMicrophone: () => recorder.mic });
    }
    const watcher = new Watcher(store, refreshTranscripts);
    const status = new StatusReceiver(store, recorder, reloadAfterFinalSummary);
    // connectServer を 2 回呼んでも、購読は 1 つにする
    let serverSubscribed = false;
    // 最終の要約ができて、サーバーに保存されたもので置き換えるセッション（取り直しで手元のものを残さない）
    let releasing: string | null = null;
    // 最終の要約ができたので取り直しているセッション（title と status の両方から呼ばれても1回にする）
    const reloadingSummaries = new Set<string>();
    // この画面から最終の文字起こしの作り直しを頼んだセッション（できたら、要約も作り直すかを聞く。#124）
    const regeneratingTranscripts = new Set<string>();

    // サーバーのバージョンを取る（起動したときと、つながり直したとき。サーバーが入れ替わっているかもしれないため）
    async function loadServerVersion() {
        if (isDemo) {
            return;
        }
        try {
            set({ serverVersion: (await api.get<VersionJson>('/api/version')).version });
        } catch {
            // 取れなければ前の値のまま
        }
    }

    // プロジェクトの並びが変わった。キャッシュのプロジェクトの一覧と画面の一覧を並べ直す（取り直さない）
    function sortProjectsBy(ids: string[]) {
        queryClient.setQueryData(projectsQuery.queryKey, (list) => list && sortByIds(list, ids));
        set((s) => ({ projects: sortByIds(s.projects, ids) }));
    }

    // WebSocket の通知・操作でストアのセッションを書き換えたあとに呼び、サーバーのデータにあたる部分を
    // キャッシュにも入れる（取り直さない）。キャッシュにまだないもの（取っていない文字起こしなど）は作らない
    function syncSessionToCache(sessionId: string) {
        const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
        const session = project?.sessions.find((x) => x.id === sessionId);
        if (!project || !session) {
            return;
        }
        const pid = project.id;
        // セッションの一覧（一覧に出す項目）
        queryClient.setQueryData(sessionsQuery(pid).queryKey, (list) =>
            list?.map((x) =>
                x.id === sessionId
                    ? {
                          ...x,
                          title: session.title,
                          status: session.status,
                          files: session.files,
                          summaryFailed: session.summaryFailed,
                      }
                    : x,
            ),
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
    }

    function findSession(sessionId: string) {
        return get()
            .projects.flatMap((p) => p.sessions)
            .find((x) => x.id === sessionId);
    }

    // セッションを画面とキャッシュの上で別のプロジェクトへ移す（サーバーには送らない）。開いていたら、移した先で開いたままにする
    function moveLocally(sessionId: string, fromId: string, toId: string) {
        const session = get()
            .projects.find((p) => p.id === fromId)
            ?.sessions.find((x) => x.id === sessionId);
        if (!session) {
            return;
        }
        set((s) => ({
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
    function patchSession(sessionId: string, change: (session: Session) => Session) {
        set((s) => ({ projects: updateSession(s.projects, sessionId, change) }));
        syncSessionToCache(sessionId);
    }

    // プロジェクトごとの参考資料セットの一覧を取り直して、キャッシュに入れる。
    // 取れなかったプロジェクトは前の一覧のまま（キャッシュは前のものが残る）
    async function refreshContextSets(projectIds: string[]) {
        await Promise.allSettled(
            projectIds.map((id) => queryClient.fetchQuery({ ...contextSetsQuery(id), staleTime: 0 })),
        );
    }

    // 最終の要約ができたら、一覧とセッションの中身をサーバーから取り直す
    async function reloadAfterFinalSummary(sessionId: string) {
        // まだ送っていなければ、最終の要約ができたか分からないまま外れたもの（成功は title で送り済み）。#206
        metrics.finish(sessionId, false);
        if (isDemo) {
            set((s) => finishDemoSummary(s, sessionId));
            return;
        }
        if (reloadingSummaries.has(sessionId)) {
            return;
        }
        reloadingSummaries.add(sessionId);
        try {
            // このセッションは手元で積み上げたものを捨てて、サーバーに保存されたもので置き換える
            releasing = sessionId;
            try {
                await get().loadProjects();
            } finally {
                releasing = null;
            }
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            const session = project?.sessions.find((x) => x.id === sessionId);
            if (project && session && !session.loaded) {
                await loadSession(project.id, session);
            } else if (session?.sources === undefined && get().liveSources[sessionId]) {
                // 音源が 2 つ以上の録音を終えた（#357）。録音中の音源の一覧を、フロントマターのもの（参加していた時間・
                // 行ごとの音源）に替える
                await refreshTranscripts(sessionId);
            }
            set((s) => ({ generating: s.generating?.sessionId === sessionId ? null : s.generating }));
        } finally {
            reloadingSummaries.delete(sessionId);
        }
    }

    // 最終の文字起こしができた（作り直した）。できた世代を出す
    async function receiveFinalTranscript(sessionId: string, gid: string) {
        const requested = regeneratingTranscripts.delete(sessionId);
        const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
        if (!project) {
            // まだ一覧にない（ほかの端末のセッションなど）
            void get().loadProjects();
            return;
        }
        try {
            const [finalTranscripts, finalTranscript] = await Promise.all([
                fetchFinalTranscripts(project.id, sessionId),
                fetchFinalTranscript(project.id, sessionId, gid),
            ]);
            patchSession(sessionId, (x) => ({
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
                action: { label: '要約も再生成する', onClick: () => void get().regenerateSummary(sessionId) },
            });
        }
    }

    // セッションを別のプロジェクトへ移したあと、一覧を取り直す。開いていたら、移した先で開いたままにする
    async function reloadAfterMove(sessionId: string, from: string, to: string) {
        // 元のプロジェクトの下のキャッシュ（文字起こし・要約など）は、もう使わない
        queryClient.removeQueries({ queryKey: [...sessionsQuery(from).queryKey, sessionId] });
        await get().loadProjects();
        const { selection } = get();
        if (selection.sessionId === sessionId && selection.projectId === from) {
            get().selectSession(to, sessionId);
        }
    }

    // 置き換え（#176）を足した・外したときの返事を、セッションに入れる
    function receiveCorrections(sessionId: string, res: CorrectionsJson) {
        patchSession(sessionId, (x) => ({
            ...x,
            pickedTerms: res.pickedTerms,
            manualTerms: res.manualTerms ?? x.manualTerms,
            corrections: res.corrections,
        }));
    }

    // 置き換えたあと（ほかの端末で置き換えたときも）、読み込み済みのセッションの文字起こし
    // （リアルタイムと、いま出している浄書済みの版）と置き換えの一覧を取り直す
    async function refreshTranscripts(sessionId: string) {
        const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
        if (!project) {
            return;
        }
        // キャッシュにある文字起こしと最終の文字起こしの世代は、置き換える前のもの
        await forgetTranscripts(project.id, sessionId);
        // 待っている間に、世代を切り替えた・読み込み終えたかもしれないので、読み直す
        const session = findSession(sessionId);
        if (!session?.loaded) {
            return;
        }
        const gid = session.finalTranscript?.generationId;
        try {
            const [transcriptJson, finalTranscript] = await Promise.all([
                fetchTranscript(project.id, sessionId),
                gid ? fetchFinalTranscript(project.id, sessionId, gid) : Promise.resolve(undefined),
            ]);
            set((s) => ({
                projects: updateSession(s.projects, sessionId, (x) => ({
                    ...x,
                    // 録音中（この端末で録音しているセッション）は、行の数を手元のままにする
                    transcript:
                        s.recordingSessionId === sessionId && x.transcript
                            ? mergeLiveLines(x.transcript, transcriptJson.lines)
                            : keepLineSources(
                                  withLineSources(transcriptJson.lines, transcriptJson.meta?.lineSources),
                                  x.transcript,
                              ),
                    pickedTerms: transcriptJson.meta?.pickedTerms ?? x.pickedTerms,
                    manualTerms: transcriptJson.meta?.manualTerms ?? x.manualTerms,
                    corrections: transcriptJson.meta?.corrections ?? x.corrections,
                    // 音源（#357）。録音を終えたら、録音中の一覧からフロントマターのもの（参加していた時間）に替える
                    sources:
                        (transcriptJson.meta?.sources?.length ?? 0) >= 2 ? transcriptJson.meta?.sources : x.sources,
                    // 取り直している間に別の版に切り替えていたら、そのまま
                    finalTranscript:
                        finalTranscript && x.finalTranscript?.generationId === gid
                            ? finalTranscript
                            : x.finalTranscript,
                })),
            }));
            syncSessionToCache(sessionId);
        } catch {
            // 取れなければ、次に開いたときに出る
        }
    }

    // セッションの文字起こしと要約を取ってくる（開いたとき）
    async function loadSession(projectId: string, session: Session) {
        try {
            const detail = await fetchSessionDetail(projectId, session, get().settings.whisper.model);
            set((s) => ({
                projects: updateSession(s.projects, session.id, (x) => ({ ...x, ...detail, loaded: true })),
            }));
        } catch (e) {
            toast.error(`セッションを読み込めません: ${(e as Error).message}`);
            // 「読み込んでいます…」のままにしない
            set((s) => ({ projects: updateSession(s.projects, session.id, (x) => ({ ...x, loaded: true })) }));
        }
    }

    // 音声ファイルから作ったセッションを開く。最終の文字起こしと最終の要約は、サーバーが後ろで作る
    async function openUploaded(projectId: string, sessionId: string) {
        metrics.awaitUpload(sessionId, get().settings);
        await get().loadProjects();
        get().selectSession(projectId, sessionId);
        // 要約が届くまでは「作成中」と出す（作り終えたら、status の summarizing から外れたことで取り直す）
        if (!get().generating) {
            set((s) => ({
                generating: {
                    sessionId,
                    model: finalModelLabel(llmModels(s.settings)),
                    text: '',
                },
            }));
        }
    }

    return {
        projects: isDemo ? demoProjects : [],
        selection: { projectId: null, sessionId: null },
        recordingState: 'idle',
        recordingSessionId: null,
        elapsed: 0,
        micLevel: 0,
        micState: 'ok',
        transcriptionStalled: false,
        unsent: null,
        unsentElsewhere: [],
        pendingAudio: 0,
        partials: [],
        joined: null,
        joinSession: (sessionId) => watcher.join(sessionId),
        leaveSession: () => watcher.leave(),
        liveSources: {},
        liveDraft: null,
        watching: null,
        settings: defaultSettings,
        settingsLoaded: isDemo,
        options: fallbackOptions,
        serverVersion: null,
        server: initialServerStatus,
        contextSelections: {},
        generating: null,
        settingsOpen: false,
        settingsPage: SETTINGS_PAGES[0],
        newProjectOpen: false,
        // デモはダミーの一覧を最初から持っている
        projectsLoaded: isDemo,
        notFound: false,
        uploading: null,

        uploadAudio: async (projectId, file) => {
            if (isDemo) {
                toast.info('デモでは音声ファイルを使えません');
                return;
            }
            if (get().uploading) {
                toast.info('ほかのファイルをアップロード中です。終わってから選び直してください');
                return;
            }
            set({ uploading: { projectId, name: file.name, percent: 0 } });
            try {
                const created = await uploadAudio(projectId, file, (percent) =>
                    set({ uploading: { projectId, name: file.name, percent } }),
                );
                await openUploaded(projectId, created.id);
                toast.success(`${file.name} から作ります。要約まで少しかかります`);
            } catch (e) {
                toast.error(`${file.name} をアップロードできません: ${(e as Error).message}`);
            } finally {
                set({ uploading: null });
            }
        },
        pickedAudio: null,
        pickAudioFiles: (projectId, files) => {
            if (files.length === 1) {
                void get().uploadAudio(projectId, files[0]);
            } else if (files.length > 1) {
                if (get().uploading) {
                    toast.info('ほかのファイルをアップロード中です。終わってから選び直してください');
                    return;
                }
                set({ pickedAudio: { projectId, files } });
            }
        },
        cancelPickedAudio: () => set({ pickedAudio: null }),
        uploadSeparately: async () => {
            const picked = get().pickedAudio;
            set({ pickedAudio: null });
            if (!picked) {
                return;
            }
            // 1 つずつ送る（同時に送れるのは 1 つだけ）。最後に作ったセッションが開く
            for (const file of picked.files) {
                await get().uploadAudio(picked.projectId, file);
            }
        },
        uploadSources: async (main) => {
            const picked = get().pickedAudio;
            set({ pickedAudio: null });
            if (!picked || isDemo || get().uploading) {
                return;
            }
            const { projectId } = picked;
            // 主の音源にするファイルを先頭にする
            const files = [picked.files[main], ...picked.files.filter((_, i) => i !== main)];
            const total = files.length;
            const progress = (i: number, percent: number) =>
                set({ uploading: { projectId, name: `${files[i].name}（${i + 1}/${total}）`, percent } });
            progress(0, 0);
            try {
                const created = await uploadAudio(projectId, files[0], (p) => progress(0, p), total);
                // 送れなかったファイル。old は 404（まとめられない古いホスト）
                const failed: string[] = [];
                let old = false;
                for (let i = 1; i < total; i++) {
                    try {
                        await uploadSource(projectId, created.id, files[i], (p) => progress(i, p));
                    } catch (e) {
                        if (e instanceof UploadError && e.status === 404) {
                            old = true;
                            break;
                        }
                        failed.push(`${files[i].name}（${(e as Error).message}）`);
                    }
                }
                await openUploaded(projectId, created.id);
                if (old) {
                    // 1 つ目のファイルだけのセッションとして浄書が始まっている
                    toast.warning(
                        `このホストは複数の音源に対応していないため、${files[0].name} だけのセッションにしました`,
                        { duration: 15000 },
                    );
                } else if (failed.length > 0) {
                    // ホストは残りのファイルを 30 分待ってから、届いた分だけで作る（spec/flows.md 6.16）
                    toast.error(
                        `${failed.join('、')} を送れませんでした。届いた ${total - failed.length} 個のファイルで、30 分後に作ります`,
                        { duration: 20000 },
                    );
                } else {
                    toast.success(`${total} 個のファイルを 1 つのセッションにまとめて作ります。要約まで少しかかります`);
                }
            } catch (e) {
                toast.error(`${files[0].name} をアップロードできません: ${(e as Error).message}`);
            } finally {
                set({ uploading: null });
            }
        },
        noProjects: false,

        loadOptions: async () => {
            try {
                // デモでは、ダミーの一覧のまま
                if (isDemo) {
                    return;
                }
                // Ollama につながらないときは、Ollama のモデルは空の一覧になる（今の設定値は選択肢に足して出す）
                set({ options: await fetchOptions() });
            } catch {
                // サーバーがないときはダミーの一覧のまま
            }
        },

        loadSettings: async () => {
            if (isDemo) {
                return;
            }
            try {
                set({ settings: await api.get<Settings>('/api/settings'), settingsLoaded: true });
            } catch (e) {
                toast.error(`設定を読み込めません: ${(e as Error).message}`);
            }
        },

        loadProjects: async () => {
            if (isDemo) {
                return;
            }
            try {
                const projects = await fetchProjects();
                // 参考資料セットの一覧も取り直す（プロジェクトの数は多くないので、まとめて取る）
                await refreshContextSets(projects.map((p) => p.id));
                set((s) => {
                    // 手元で中身を積み上げているセッションは、取り直しで消さない
                    const keep = new Set(
                        [s.recordingSessionId, s.generating?.sessionId, recorder.stoppedWhileOffline].filter(
                            (id): id is string => !!id && id !== releasing,
                        ),
                    );
                    return {
                        projects: mergeProjects(s.projects, projects, keep),
                        projectsLoaded: true,
                    };
                });
            } catch (e) {
                toast.error(`プロジェクトを読み込めません: ${(e as Error).message}`);
                return;
            }
            // 開いているセッションの中身が取り直しで無くなっていたら、読み直す
            const s = get();
            const project = currentProject(s);
            const session = currentSession(s);
            if (project && session && !session.loaded) {
                await loadSession(project.id, session);
            }
        },

        createProject: async (path) => {
            try {
                const project = await api.post<ProjectJson>('/api/projects', { path });
                await get().loadProjects();
                set({ selection: { projectId: project.id, sessionId: null } });
                toast.success(`${project.path} をプロジェクトにしました`);
            } catch (e) {
                toast.error(`プロジェクトにできません: ${(e as Error).message}`);
            }
        },

        selectSession: (projectId, sessionId) => {
            set({ selection: { projectId, sessionId } });
            const session = get()
                .projects.find((p) => p.id === projectId)
                ?.sessions.find((x) => x.id === sessionId);
            if (!isDemo && session && !session.loaded) {
                void loadSession(projectId, session);
            }
        },
        newSession: (projectId) => set({ selection: { projectId, sessionId: null } }),
        showRecordingSession: () => {
            const sessionId = get().recordingSessionId;
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (sessionId && project) {
                get().selectSession(project.id, sessionId);
            }
        },

        startRecording: async () => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                toast.info('録音するプロジェクトをメニューから選んでください');
                return;
            }
            // 既存のセッションを開いていたら、同じプロジェクトの新しいセッションの画面に切り替えるだけにする
            // 録音を始める前に、モデルや参考資料を選び直せるようにするため
            if (currentSession(s)) {
                set({ selection: { projectId: project.id, sessionId: null } });
                return;
            }
            await startNew(recorder, project.id);
        },

        recoverUnsent: () => recoverUnsent(recorder),
        discardUnsentElsewhere: (hosts) => discardUnsentElsewhere(recorder, hosts),
        discardUnsent: () => discardUnsent(recorder),

        rejectTerm: async (sessionId, term) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            const drop = (terms?: string[]) => terms?.filter((t) => t !== term);
            await runMutation(
                {
                    // 先に画面から消す（失敗したら戻す）
                    onMutate: () => {
                        const old = findSession(sessionId);
                        patchSession(sessionId, (x) => ({
                            ...x,
                            pickedTerms: drop(x.pickedTerms),
                            manualTerms: drop(x.manualTerms),
                        }));
                        return { pickedTerms: old?.pickedTerms, manualTerms: old?.manualTerms };
                    },
                    // 語はクエリで渡す（パスに入れると「\」「..」「%」を含む語がクラウド版の中継で弾かれる。#219）
                    mutationFn: async () =>
                        isDemo
                            ? null
                            : api.delete<TermsJson>(
                                  `/api/projects/${project.id}/sessions/${sessionId}/terms?${new URLSearchParams({ term }).toString()}`,
                              ),
                    onSuccess: (res) => {
                        if (res) {
                            patchSession(sessionId, (x) => ({
                                ...x,
                                pickedTerms: res.pickedTerms,
                                manualTerms: res.manualTerms ?? x.manualTerms,
                            }));
                        }
                    },
                    onError: (e, _v, before) => {
                        patchSession(sessionId, (x) => ({ ...x, ...before }));
                        toast.error(`用語を消せません: ${e.message}`);
                    },
                },
                undefined,
            ).catch(() => {});
        },

        addTerm: async (sessionId, term) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return false;
            }
            // 足せるか（不正な語・上限）はサーバーが決めるので、先には足さない
            return runMutation(
                {
                    mutationFn: async (): Promise<TermsJson> =>
                        isDemo
                            ? {
                                  manualTerms: [...new Set([...(findSession(sessionId)?.manualTerms ?? []), term])],
                                  pickedTerms: (findSession(sessionId)?.pickedTerms ?? []).filter((t) => t !== term),
                                  rejectedTerms: [],
                              }
                            : api.post<TermsJson>(`/api/projects/${project.id}/sessions/${sessionId}/terms`, { term }),
                    onSuccess: (res) =>
                        patchSession(sessionId, (x) => ({
                            ...x,
                            pickedTerms: res.pickedTerms,
                            manualTerms: res.manualTerms ?? x.manualTerms,
                        })),
                    onError: (e) => toast.error(`用語を足せません: ${e.message}`),
                },
                undefined,
            ).then(
                () => true,
                () => false,
            );
        },

        moveSession: async (fromProjectId, sessionId, toProjectId) => {
            const from = get().projects.find((p) => p.id === fromProjectId);
            const to = get().projects.find((p) => p.id === toProjectId);
            const session = from?.sessions.find((x) => x.id === sessionId);
            if (!from || !to || !session || from.id === to.id) {
                return;
            }
            await runMutation(
                {
                    // 先に画面とキャッシュで移しておく（失敗したら戻す）
                    onMutate: () => moveLocally(sessionId, from.id, to.id),
                    mutationFn: async () => {
                        if (!isDemo) {
                            await api.post(`/api/projects/${from.id}/sessions/${sessionId}/move`, { to: to.id });
                        }
                    },
                    onSuccess: async () => {
                        if (!isDemo) {
                            await reloadAfterMove(sessionId, from.id, to.id);
                        }
                        toast.success(`「${session.title}」を${to.name}へ移しました`);
                    },
                    // 戻すときは逆向きに移す（待っている間に届いた、ほかのセッションの変更は消さない）
                    onError: (e) => {
                        moveLocally(sessionId, to.id, from.id);
                        toast.error(`「${session.title}」を移せません: ${e.message}`);
                    },
                },
                undefined,
            ).catch(() => {});
        },

        reorderProjects: async (ids) => {
            await runMutation(
                {
                    // 先に画面を入れ替えておく（保存を待つと、離した瞬間に元の位置へ戻って見える）
                    onMutate: () => {
                        const before = {
                            ids: get().projects.map((p) => p.id),
                            projectOrder: get().settings.projectOrder,
                        };
                        sortProjectsBy(ids);
                        set((s) => ({ settings: { ...s.settings, projectOrder: ids } }));
                        return before;
                    },
                    mutationFn: async () => {
                        if (!isDemo) {
                            await api.patch('/api/settings', { projectOrder: ids });
                        }
                    },
                    // 保存できなかったので、前の並びに戻す
                    onError: (e, _v, before) => {
                        toast.error(`プロジェクトの並びを保存できません: ${e.message}`);
                        if (before) {
                            sortProjectsBy(before.ids);
                            set((s) => ({ settings: { ...s.settings, projectOrder: before.projectOrder } }));
                        }
                    },
                },
                undefined,
            ).catch(() => {});
        },

        addCorrection: async (sessionId, correction) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return false;
            }
            return runMutation(
                {
                    // 先に画面で置き換えておく（失敗したら戻す）
                    onMutate: () => {
                        const before = findSession(sessionId);
                        patchSession(sessionId, (x) => applyCorrectionLocally(x, correction));
                        return before;
                    },
                    mutationFn: async () =>
                        isDemo
                            ? null
                            : api.post<CorrectionsJson>(
                                  `/api/projects/${project.id}/sessions/${sessionId}/corrections`,
                                  correction,
                              ),
                    onSuccess: async (res) => {
                        if (res) {
                            receiveCorrections(sessionId, res);
                            await refreshTranscripts(sessionId);
                        }
                    },
                    // 戻す。待っている間に届いた行（録音中）は残す
                    onError: (e, _v, before) => {
                        toast.error(`置き換えられません: ${e.message}`);
                        if (before) {
                            patchSession(sessionId, (x) => ({
                                ...x,
                                transcript: [...before.transcript, ...x.transcript.slice(before.transcript.length)],
                                finalTranscript:
                                    x.finalTranscript?.generationId === before.finalTranscript?.generationId
                                        ? before.finalTranscript
                                        : x.finalTranscript,
                                manualTerms: before.manualTerms,
                                corrections: before.corrections,
                            }));
                        }
                    },
                },
                undefined,
            ).then(
                () => true,
                () => false,
            );
        },

        removeCorrection: async (sessionId, correction) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            const same = (c: Correction) => c.from === correction.from && c.to === correction.to;
            await runMutation(
                {
                    // 先に一覧から外しておく（失敗したら戻す）。文字起こしの中身は、外せたら取り直して戻す
                    onMutate: () => {
                        const before = findSession(sessionId)?.corrections;
                        patchSession(sessionId, (x) => ({ ...x, corrections: x.corrections?.filter((c) => !same(c)) }));
                        return before;
                    },
                    mutationFn: async () =>
                        isDemo
                            ? null
                            : api.delete<CorrectionsJson>(
                                  `/api/projects/${project.id}/sessions/${sessionId}/corrections?${new URLSearchParams({ from: correction.from, to: correction.to })}`,
                              ),
                    onSuccess: async (res) => {
                        if (res) {
                            receiveCorrections(sessionId, res);
                            // 浄書済みの文字起こしは表示のときに当てているので、外したら取り直す
                            await refreshTranscripts(sessionId);
                        }
                    },
                    onError: (e, _v, before) => {
                        patchSession(sessionId, (x) => ({ ...x, corrections: before }));
                        toast.error(`置き換えを外せません: ${e.message}`);
                    },
                },
                undefined,
            ).catch(() => {});
        },

        reopenMicrophone: () => reopenMicrophone(recorder),
        continueRecording: (sessionId) => continueRecording(recorder, sessionId),
        pauseRecording: () => pauseRecording(recorder),
        resumeRecording: () => unpauseRecording(recorder),
        stopRecording: () => stopRecording(recorder),

        watchMicrophone: () => {
            void watchMicrophonePermission((denied) =>
                set((s) => ({ server: { ...s.server, microphone: denied ? 'denied' : 'granted' } })),
            );
        },

        // サーバーにつなぎ続け、状態（status）とエラーを受け取る（spec/api.md 7.2）
        // 接続が切れているかどうかは status に含まれないので、ブラウザ側で判定する
        connectServer: () => {
            if (serverSubscribed) {
                return;
            }
            serverSubscribed = true;
            connectServer({
                store,
                recorder,
                watcher,
                status,
                loadServerVersion,
                sessions: {
                    regeneratingTranscripts,
                    receiveFinalTranscript,
                    reloadAfterMove,
                    reloadAfterFinalSummary,
                    refreshTranscripts,
                    refreshContextSets,
                    sortProjectsBy,
                    patchSession,
                    syncSessionToCache,
                    cachedContextSets,
                    updateCachedContextSets,
                },
            });
        },

        // 簡易設定・設定モーダルのどちらからでも呼ぶ。全体設定を保存する（PATCH /api/settings）。保存できたら true
        changeSettings: async (next) => {
            if (isDemo) {
                set({ settings: next });
                return true;
            }
            // 読み終わる前の settings は既定値。これを送ると、サーバーの設定が既定値で上書きされる（#339）
            if (!get().settingsLoaded) {
                toast.error('設定を読み込めていないため、保存できません');
                return false;
            }
            const before = finalModelLabel(llmModels(get().settings));
            const backendBefore = llmBackend(get().settings);
            try {
                // 並び順（#173）は並び替えのときだけ送る。古い設定で、ほかの端末の並び替えを上書きしないように
                const { projectOrder: _order, ...patch } = next;
                set({ settings: await api.patch<Settings>('/api/settings', patch) });
                // LLM（Ollama か LM Studio）を切り替えたら、選べるモデルの一覧を取り直す（#327）
                const switched = llmBackend(get().settings) !== backendBefore;
                if (switched) {
                    void get().loadOptions();
                }
                // 最終の要約のモデル（全体概要か要約詳細。#178）を変えたら、開いているセッションにその組の要約が
                // なければ作り直す（spec/flows.md 6.5）。録音中は作り直さない（録音中の文字起こしが止まるため。#133）。
                // LLM を切り替えただけ（モデルの名前の付け方が変わるだけ）では作り直さない
                const models = llmModels(get().settings);
                const session = currentSession(get());
                if (
                    !switched &&
                    finalModelLabel(models) !== before &&
                    session &&
                    needsSummaryFor(session, models) &&
                    !get().generating &&
                    get().recordingState === 'idle'
                ) {
                    void get().regenerateSummary(session.id);
                }
                return true;
            } catch (e) {
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中は、文字起こしのモデル・区切り・マイクの処理は変えられません');
                } else {
                    toast.error(`設定を保存できません: ${(e as Error).message}`);
                }
                return false;
            }
        },

        regenerateFinalTranscript: async (sessionId) => {
            if (isDemo) {
                toast.info('デモでは文字起こしを再生成できません');
                return;
            }
            if (get().recordingState !== 'idle') {
                toast.warning(recordingLocks.regenerate);
                return;
            }
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            // 返事より先に結果（失敗の error）が届くこともあるので、頼む前に覚えておく
            regeneratingTranscripts.add(sessionId);
            try {
                // 結果は WebSocket（finalTranscript か error）で届く。作っている間は status の transcribing に入る
                await api.post(`/api/projects/${project.id}/sessions/${sessionId}/final-transcripts`);
            } catch (e) {
                regeneratingTranscripts.delete(sessionId);
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');
                } else if (e instanceof ApiError && e.status === 410) {
                    toast.error('録音ファイルが期限切れのため、再生成できません');
                } else {
                    toast.error(`文字起こしを再生成できません: ${(e as Error).message}`);
                }
            }
        },

        showFinalTranscript: async (sessionId, generationId) => {
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            try {
                const finalTranscript = await fetchFinalTranscript(project.id, sessionId, generationId);
                set((s) => ({
                    projects: updateSession(s.projects, sessionId, (x) => ({ ...x, finalTranscript })),
                }));
            } catch (e) {
                toast.error(`文字起こしを読み込めません: ${(e as Error).message}`);
            }
        },

        regenerateSummary: async (sessionId) => {
            if (isDemo) {
                toast.info('デモでは要約を再生成できません');
                return;
            }
            if (get().recordingState !== 'idle') {
                toast.warning(recordingLocks.regenerate);
                return;
            }
            const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
            if (!project) {
                return;
            }
            status.finishedSummaries.delete(sessionId);
            try {
                const reply = await api.post<{ model: string; overviewModel?: string }>(
                    `/api/projects/${project.id}/sessions/${sessionId}/summaries`,
                );
                // 全体概要と要約詳細のモデル（#178。古いサーバーは model だけ）
                const model = finalModelLabel({
                    ...llmModels(get().settings),
                    detail: reply.model,
                    overview: reply.overviewModel ?? reply.model,
                });
                if (status.finishedSummaries.has(sessionId)) {
                    // 返事より先に作り終えていた（「作成中」にすると、消すきっかけがもう来ない）
                    void reloadAfterFinalSummary(sessionId);
                    return;
                }
                // 結果は WebSocket（summary.delta）で届く。届くまでは「作成中」と出す。
                // 返事より先に届いた分があれば残す
                set((s) => ({
                    generating: {
                        sessionId,
                        model,
                        text: s.generating?.sessionId === sessionId ? s.generating.text : '',
                    },
                }));
            } catch (e) {
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');
                } else if (e instanceof ApiError && e.status === 410) {
                    toast.error('文字起こしが期限切れのため、再生成できません');
                } else {
                    toast.error(`要約を再生成できません: ${(e as Error).message}`);
                }
            }
        },

        // 使うセットと、用語リスト・コンテキストを使うかを保存する（PATCH .../selection）。録音中は 409
        changeContextSelection: async (next) => {
            const project = currentProject(get());
            if (!project) {
                return;
            }
            // 保存するまでの間だけ、手元の選択（contextSelections）で上書きして出す
            const pid = project.id;
            const clearOverride = (s: AppState) => {
                const selections = { ...s.contextSelections };
                delete selections[pid];
                return selections;
            };
            if (isDemo) {
                set((s) => ({ contextSelections: { ...s.contextSelections, [pid]: next } }));
                return;
            }
            await runMutation(
                {
                    onMutate: () => set((s) => ({ contextSelections: { ...s.contextSelections, [pid]: next } })),
                    mutationFn: () =>
                        api.patch<ProjectJson['selection']>(`/api/projects/${pid}/selection`, {
                            contextSet: next.setId,
                            useHotwords: next.useHotwords,
                            useContext: next.useContext,
                            pickTerms: next.pickTerms,
                        }),
                    // 保存できたら、サーバーの選択（project.selection）を正にして、手元の上書きは消す
                    // （ほかの端末で変えた選択も、取り直しで出るように）。キャッシュのプロジェクトの一覧も合わせる
                    onSuccess: (saved) => {
                        const selection = toSelection(saved);
                        queryClient.setQueryData(projectsQuery.queryKey, (list) =>
                            list?.map((p) => (p.id === pid ? { ...p, selection } : p)),
                        );
                        set((s) => ({
                            projects: s.projects.map((p) => (p.id === pid ? { ...p, selection } : p)),
                            contextSelections: clearOverride(s),
                        }));
                    },
                    // 保存できなければ、上書きを消して元（サーバーの選択）に戻す
                    onError: (e) => {
                        set((s) => ({ contextSelections: clearOverride(s) }));
                        if (e instanceof ApiError && e.status === 409) {
                            toast.error('録音中は参考資料を変えられません');
                        } else {
                            toast.error(`参考資料の選択を保存できません: ${e.message}`);
                        }
                    },
                },
                undefined,
            ).catch(() => {});
        },

        // 資料を送ってセットの作成を始める（POST .../context-sets）。できたかは contextSet で届く。
        // 同じ資料の組み合わせのセットがあれば、サーバーが使い回す（spec/flows.md 6.6 節）
        createContextSet: async (materials) => {
            const s = get();
            const project = currentProject(s);
            if (!project) {
                return;
            }
            const pid = project.id;
            const selection = currentContextSelection(s, cachedContextSets(pid));
            if (!isDemo) {
                try {
                    const created = await api.post<ContextSet & { reused: boolean }>(
                        `/api/projects/${pid}/context-sets`,
                        { materials },
                    );
                    const entry: ContextSet = { id: created.id, status: created.status, materials: created.materials };
                    // 一覧は ID の昇順（サーバーと同じ）
                    updateCachedContextSets(pid, (sets) =>
                        [...sets.filter((x) => x.id !== entry.id), entry].sort((a, b) => a.id.localeCompare(b.id)),
                    );
                    if (created.reused) {
                        toast.info('同じ資料の参考資料があるので、それを使います');
                    }
                    await get().changeContextSelection({ ...selection, setId: created.id });
                } catch (e) {
                    toast.error(`参考資料を作れません: ${(e as Error).message}`);
                }
                return;
            }
            const same = cachedContextSets(pid).find((x) => x.materials.join('\n') === materials.join('\n'));
            if (same) {
                get().changeContextSelection({ ...selection, setId: same.id });
                toast.info('同じ資料の参考資料があるので、それを使います');
                return;
            }
            const created: ContextSet = { id: newId(), status: 'generating', materials };
            updateCachedContextSets(pid, (sets) => [...sets, created]);
            get().changeContextSelection({ ...selection, setId: created.id });
            setTimeout(() => {
                updateCachedContextSets(pid, (sets) =>
                    sets.map((x) => (x.id === created.id ? { ...x, status: 'ready' } : x)),
                );
                toast.success('参考資料ができました');
            }, 4000);
        },

        setServer: (server) => set({ server }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setSettingsPage: (settingsPage) => set({ settingsPage }),
        setNewProjectOpen: (newProjectOpen) => set({ newProjectOpen }),
        setNoProjects: (noProjects) => set({ noProjects }),
    };
});

// デモではダミーの参考資料セットを最初からキャッシュに入れておく（サーバーにつなぐときは、プロジェクトの一覧と一緒に取る）
if (isDemo) {
    for (const [pid, sets] of Object.entries(initialContextSets)) {
        // setQueryData だと既定の gcTime（5 分）で作られて捨てられるので、contextSetsQuery の設定で入れる
        void queryClient.prefetchQuery({ ...contextSetsQuery(pid), queryFn: () => sets });
    }
}

// 録音中（一時停止中も）は、画面がスリープしないようにする（#102）
useAppStore.subscribe((s, prev) => {
    if (s.recordingSessionId !== prev.recordingSessionId) {
        keepScreenOn(s.recordingSessionId !== null);
    }
});

// 開発中は、ブラウザの開発者ツールや Playwright からストアと接続を見られるようにする
// （接続は、切れたときの動きを確かめるため）
if (import.meta.env.DEV) {
    Object.assign(window, {
        appStore: useAppStore,
        // サーバーのデータのキャッシュ（#330。参考資料セットの一覧など）
        appQueryClient: queryClient,
        appConnection: connection,
        // 画面のスリープを止めているかを確かめるため（#102）
        appScreenKeptOn: screenKeptOn,
    });
}
