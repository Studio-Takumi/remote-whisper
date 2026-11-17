// 画面の状態をまとめて持つストア。プロジェクト・セッション・設定はサーバーの API から取る（spec/api.md 7.1）。
// ここには画面が読む状態とアクションの入口だけを置き、中身は features/ と app/ のモジュールに置く
import { create } from 'zustand';

import { connection } from '@/api/connection';
import { contextSetsQuery, isDemo } from '@/api/data';
import { demoProjects, fallbackOptions, initialContextSets } from '@/api/mock';
import { initialServerStatus } from '@/api/status';
import type { ActionContext } from '@/app/actionContext';
import type { AppState } from '@/app/appState';
import { queryClient } from '@/app/query';
import { connectServer } from '@/app/serverConnection';
import { StatusReceiver } from '@/app/serverStatus';
import { SessionSync } from '@/app/sessionSync';
import { changeContextSelection, createContextSet } from '@/features/materials/contextSetActions';
import {
    createProject,
    loadProjects,
    moveSession,
    reorderProjects,
    selectSession,
    showRecordingSession,
} from '@/features/projects/projectActions';
import { watchMicrophonePermission } from '@/features/recording/audio/microphone';
import { keepScreenOn, screenKeptOn } from '@/features/recording/audio/wakeLock';
import {
    continueRecording,
    pauseRecording,
    reopenMicrophone,
    startRecording,
    stopRecording,
    unpauseRecording,
} from '@/features/recording/recorder';
import { createRecorder } from '@/features/recording/recorderState';
import { discardUnsent, discardUnsentElsewhere, recoverUnsent } from '@/features/recording/unsentRecovery';
import { pickAudioFiles, uploadAudio, uploadSeparately, uploadSources } from '@/features/recording/uploadActions';
import { Watcher } from '@/features/recording/watcher';
import {
    regenerateFinalTranscript,
    regenerateSummary,
    showFinalTranscript,
} from '@/features/session/regenerateActions';
import { addCorrection, addTerm, rejectTerm, removeCorrection } from '@/features/session/transcriptActions';
import { SETTINGS_PAGES, defaultSettings } from '@/features/settings/settings';
import { changeSettings, loadOptions, loadSettings } from '@/features/settings/settingsActions';

export type { LivePartial } from '@/features/session/livePartials';

// 録音・見る・WebSocket の受け取り・セッションの取り直しは、ストアごとに 1 つ作る
function createContext(store: ActionContext['store']): ActionContext & { watcher: Watcher } {
    const recorder = createRecorder(store);
    const sessions = new SessionSync(store, recorder.metrics);
    const watcher = new Watcher(store, sessions.refreshTranscripts);
    const status = new StatusReceiver(store, recorder, sessions.reloadAfterFinalSummary);
    // 開発中は、マイクが止まったときの動きを確かめられるようにする（#102）
    if (import.meta.env.DEV) {
        Object.assign(window, { appMicrophone: () => recorder.mic });
    }
    return { store, recorder, sessions, watcher, status };
}

export const useAppStore = create<AppState>()((set, _get, store) => {
    const ctx = createContext(store);
    const { recorder, watcher } = ctx;
    // connectServer を 2 回呼んでも、購読は 1 つにする
    let serverSubscribed = false;

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
        pickedAudio: null,
        noProjects: false,

        // 録音（features/recording）
        startRecording: () => startRecording(recorder),
        continueRecording: (sessionId) => continueRecording(recorder, sessionId),
        pauseRecording: () => pauseRecording(recorder),
        resumeRecording: () => unpauseRecording(recorder),
        stopRecording: () => stopRecording(recorder),
        reopenMicrophone: () => reopenMicrophone(recorder),
        recoverUnsent: () => recoverUnsent(recorder),
        discardUnsent: () => discardUnsent(recorder),
        discardUnsentElsewhere: (hosts) => discardUnsentElsewhere(recorder, hosts),
        joinSession: (sessionId) => watcher.join(sessionId),
        leaveSession: () => watcher.leave(),
        watchMicrophone: () => {
            void watchMicrophonePermission((denied) =>
                set((s) => ({ server: { ...s.server, microphone: denied ? 'denied' : 'granted' } })),
            );
        },
        uploadAudio: (projectId, file) => uploadAudio(ctx, projectId, file),
        pickAudioFiles: (projectId, files) => pickAudioFiles(ctx, projectId, files),
        cancelPickedAudio: () => set({ pickedAudio: null }),
        uploadSeparately: () => uploadSeparately(ctx),
        uploadSources: (main) => uploadSources(ctx, main),

        // サーバーにつなぎ続け、状態（status）とメッセージを受け取る（app/serverConnection）
        connectServer: () => {
            if (!serverSubscribed) {
                serverSubscribed = true;
                connectServer(ctx);
            }
        },

        // プロジェクトとセッション（features/projects）
        loadProjects: () => loadProjects(ctx),
        createProject: (path) => createProject(ctx, path),
        selectSession: (projectId, sessionId) => selectSession(ctx, projectId, sessionId),
        newSession: (projectId) => set({ selection: { projectId, sessionId: null } }),
        showRecordingSession: () => showRecordingSession(ctx),
        moveSession: (fromProjectId, sessionId, toProjectId) => moveSession(ctx, fromProjectId, sessionId, toProjectId),
        reorderProjects: (ids) => reorderProjects(ctx, ids),

        // 文字起こし・要約（features/session）
        rejectTerm: (sessionId, term) => rejectTerm(ctx, sessionId, term),
        addTerm: (sessionId, term) => addTerm(ctx, sessionId, term),
        addCorrection: (sessionId, correction) => addCorrection(ctx, sessionId, correction),
        removeCorrection: (sessionId, correction) => removeCorrection(ctx, sessionId, correction),
        regenerateFinalTranscript: (sessionId) => regenerateFinalTranscript(ctx, sessionId),
        showFinalTranscript: (sessionId, generationId) => showFinalTranscript(ctx, sessionId, generationId),
        regenerateSummary: (sessionId) => regenerateSummary(ctx, sessionId),

        // 設定と参考資料（features/settings・features/materials）
        loadOptions: () => loadOptions(ctx),
        loadSettings: () => loadSettings(ctx),
        changeSettings: (next) => changeSettings(ctx, next),
        changeContextSelection: (next) => changeContextSelection(ctx, next),
        createContextSet: (materials) => createContextSet(ctx, materials),

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
