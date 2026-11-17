// ストアの外（操作・WebSocket の受け取り）から、プロジェクトとセッションを読む・書き換える（#361）。
// サーバーのデータはキャッシュから読み、手元で積み上げているセッション（localSessions）はストアから読む
import { type ProjectInfo, projectsQuery } from '@/api/projects';
import { sessionsQuery } from '@/api/sessions';
import type { Project, Session } from '@/api/types';
import type { AppState, AppStore } from '@/app/appState';
import { queryClient } from '@/app/query';
import { cachedParts, writeSessionToCache } from '@/app/sessionCache';
import { type LocalSession, findLocal, patchLocal, putLocal } from '@/features/projects/localSessions';
import { buildProjects } from '@/features/projects/projectsView';
import { type LoadedSession, sessionFrom } from '@/features/session/sessionDetail';

export function readProjectInfos(): ProjectInfo[] {
    return queryClient.getQueryData(projectsQuery.queryKey) ?? [];
}

function readRows(projectId: string) {
    return queryClient.getQueryData(sessionsQuery(projectId).queryKey);
}

// プロジェクトの一覧。手元のセッション以外は、一覧の行だけ（中身は readSession で読む）
export function readProjects(s: AppState): Project[] {
    const infos = readProjectInfos();
    return buildProjects(
        infos,
        infos.map((p) => readRows(p.id)),
        s.localSessions,
    );
}

// セッションのあるプロジェクトの ID
export function projectIdOf(s: AppState, sessionId: string): string | undefined {
    const local = findLocal(s.localSessions, sessionId);
    if (local) {
        return local.projectId;
    }
    return readProjectInfos().find((p) => readRows(p.id)?.some((x) => x.id === sessionId))?.id;
}

// 一覧の行に、キャッシュにある中身を足したもの
export function withDetail(s: AppState, projectId: string, row: Session): Session {
    const loaded = s.loadedSessions[row.id];
    return sessionFrom(row, cachedParts(projectId, row.id, loaded?.finalTranscript), loaded);
}

// セッション（中身を取っていれば中身も）
export function readSession(s: AppState, sessionId: string): Session | undefined {
    const local = findLocal(s.localSessions, sessionId);
    if (local) {
        return local.session;
    }
    const pid = projectIdOf(s, sessionId);
    const row = pid ? readRows(pid)?.find((x) => x.id === sessionId) : undefined;
    return pid && row ? withDetail(s, pid, row) : undefined;
}

// 手元で積み上げ始める（録音の続き・届かなかった音声の送り直し）。今のセッションを写して change を当てたもの
export function holdSession(s: AppState, sessionId: string, change: (session: Session) => Session): LocalSession[] {
    const pid = projectIdOf(s, sessionId);
    const session = readSession(s, sessionId);
    return pid && session ? putLocal(s.localSessions, { projectId: pid, session: change(session) }) : s.localSessions;
}

// 中身を取った（取れなかった）ことと、出している最終の文字起こしの世代を覚える。null なら忘れる（次に開いたら取り直す）
export function setLoaded(store: AppStore, sessionId: string, loaded: LoadedSession | null) {
    store.setState((s) => {
        const next = { ...s.loadedSessions };
        if (loaded) {
            next[sessionId] = loaded;
        } else {
            delete next[sessionId];
        }
        return { loadedSessions: next };
    });
}

// セッションを書き換える。手元のセッションならストアを、それ以外はキャッシュを書き換える
export function patchSessionData(store: AppStore, sessionId: string, change: (session: Session) => Session) {
    const s = store.getState();
    if (findLocal(s.localSessions, sessionId)) {
        store.setState((st) => ({ localSessions: patchLocal(st.localSessions, sessionId, change) }));
        return;
    }
    const pid = projectIdOf(s, sessionId);
    const before = pid ? readSession(s, sessionId) : undefined;
    if (!pid || !before) {
        return;
    }
    const after = change(before);
    writeSessionToCache(pid, before, after);
    const gid = after.finalTranscript?.generationId;
    if ((after.loaded && !before.loaded) || (gid && gid !== before.finalTranscript?.generationId)) {
        const loaded = store.getState().loadedSessions[sessionId];
        setLoaded(store, sessionId, { ...loaded, ...(gid ? { finalTranscript: gid } : {}) });
    }
}
