// プロジェクトとセッションの一覧を取り直す（spec/api.md 7.1）。一覧と中身はキャッシュに入り、
// 手元で積み上げているセッション（localSessions）は、積み上げている間は取り直しで置き換えない（#361）
import { toast } from 'sonner';

import { fetchProjects, isDemo, sessionsQuery } from '@/api/data';
import type { Project, Session } from '@/api/types';
import type { ActionContext } from '@/app/actionContext';
import { queryClient } from '@/app/query';
import { currentProject, currentSession } from '@/app/selectors';
import { readProjectInfos, readSession } from '@/app/sessionData';
import { refreshContextSets } from '@/features/materials/contextSetCache';
import { findLocal, putLocal } from '@/features/projects/localSessions';
import { needsReload } from '@/features/projects/projectsView';
import { offlineStoppedSession } from '@/features/recording/recorderState';

// 手元で中身を積み上げているセッション（自分が録音中・最終の要約を待っているもの）。最終の要約ができて
// サーバーのもので置き換えているもの（releasing）は除く
function heldSessionIds(ctx: ActionContext) {
    const s = ctx.store.getState();
    const ids = [s.recordingSessionId, s.generating?.sessionId, offlineStoppedSession(ctx.recorder)];
    return new Set(ids.filter((id): id is string => !!id && !ctx.sessions.isReleasing(id)));
}

// 積み上げているのにまだストアにない（キャッシュのものを書き換えていた）セッションを、取り直す前にストアに移す
function holdSessions(ctx: ActionContext, held: Set<string>) {
    const { getState: get, setState: set } = ctx.store;
    for (const id of held) {
        const pid = ctx.sessions.projectIdOf(id);
        const session = readSession(get(), id);
        if (pid && session && !findLocal(get().localSessions, id)) {
            set((s) => ({ localSessions: putLocal(s.localSessions, { projectId: pid, session }) }));
        }
    }
}

// 今キャッシュにあるセッションの一覧の行（セッション ID ごと）
function cachedRows() {
    const rows = readProjectInfos().flatMap((p) => queryClient.getQueryData(sessionsQuery(p.id).queryKey) ?? []);
    return new Map(rows.map((x) => [x.id, x]));
}

// 取り直した一覧に合わせる。積み上げ終えたセッションはストアから外し、中身が変わったものは次に開いたときに取り直す
function settle(ctx: ActionContext, before: Map<string, Session>, projects: Project[]) {
    const held = heldSessionIds(ctx);
    ctx.store.setState((s) => {
        const released = s.localSessions.filter((x) => !held.has(x.session.id)).map((x) => x.session.id);
        const stale = projects.flatMap((p) => p.sessions).filter((x) => needsReload(before.get(x.id), x));
        const loadedSessions = { ...s.loadedSessions };
        for (const id of [...released, ...stale.map((x) => x.id)]) {
            if (!held.has(id)) {
                delete loadedSessions[id];
            }
        }
        return {
            localSessions: s.localSessions.filter((x) => held.has(x.session.id)),
            loadedSessions,
            projectsLoaded: true,
        };
    });
}

export async function loadProjects(ctx: ActionContext) {
    if (isDemo) {
        return;
    }
    holdSessions(ctx, heldSessionIds(ctx));
    const before = cachedRows();
    try {
        const projects = await fetchProjects();
        // 参考資料セットの一覧も取り直す（プロジェクトの数は多くないので、まとめて取る）
        await refreshContextSets(projects.map((p) => p.id));
        settle(ctx, before, projects);
    } catch (e) {
        toast.error(`プロジェクトを読み込めません: ${(e as Error).message}`);
        return;
    }
    // 開いているセッションの中身が取り直しで無くなっていたら、読み直す
    const s = ctx.store.getState();
    const project = currentProject(s);
    const session = currentSession(s);
    if (project && session && !session.loaded) {
        await ctx.sessions.loadSession(project.id, session);
    }
}
