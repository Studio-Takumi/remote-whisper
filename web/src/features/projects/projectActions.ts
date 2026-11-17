// プロジェクトとセッションを開く・作る・移す・並べ替える（spec/api.md 7.1）
import { toast } from 'sonner';

import { type ProjectJson, api } from '@/api/api';
import { isDemo } from '@/api/demo';
import { projectsQuery } from '@/api/projects';
import { sessionsQuery } from '@/api/sessions';
import type { ActionContext } from '@/app/actionContext';
import { queryClient, runMutation } from '@/app/query';
import { readProjectInfos, readProjects, readSession } from '@/app/sessionData';
import { type ProjectOrder, reorderTracker } from '@/features/projects/reorderTracker';

export async function createProject(ctx: ActionContext, path: string) {
    const { getState: get, setState: set } = ctx.store;
    try {
        const project = await api.post<ProjectJson>('/api/projects', { path });
        await get().loadProjects();
        set({ selection: { projectId: project.id, sessionId: null } });
        toast.success(`${project.path} をプロジェクトにしました`);
    } catch (e) {
        toast.error(`プロジェクトにできません: ${(e as Error).message}`);
    }
}

export function selectSession(ctx: ActionContext, projectId: string, sessionId: string) {
    const { getState: get, setState: set } = ctx.store;
    set({ selection: { projectId, sessionId } });
    const session = ctx.sessions.projectIdOf(sessionId) === projectId ? readSession(get(), sessionId) : undefined;
    if (!isDemo && session && !session.loaded) {
        void ctx.sessions.loadSession(projectId, session);
    }
}

export function showRecordingSession(ctx: ActionContext) {
    const get = ctx.store.getState;
    const sessionId = get().recordingSessionId;
    const projectId = sessionId ? ctx.sessions.projectIdOf(sessionId) : undefined;
    if (sessionId && projectId) {
        get().selectSession(projectId, sessionId);
    }
}

// 一覧（プロジェクトと、projectIds のセッションの一覧）の取り直しの途中なら止める。待たない（画面はすぐ変える）
function cancelLists(projectIds: string[]) {
    for (const key of [projectsQuery.queryKey, ...projectIds.map((id) => sessionsQuery(id).queryKey)]) {
        void queryClient.cancelQueries({ queryKey: key, exact: true });
    }
}

export async function moveSession(ctx: ActionContext, fromProjectId: string, sessionId: string, toProjectId: string) {
    const projects = readProjects(ctx.store.getState());
    const from = projects.find((p) => p.id === fromProjectId);
    const to = projects.find((p) => p.id === toProjectId);
    const session = from?.sessions.find((x) => x.id === sessionId);
    if (!from || !to || !session || from.id === to.id) {
        return;
    }
    await runMutation(
        {
            // 先に画面とキャッシュで移しておく（失敗したら戻す）。取り直しの途中なら止める（古い一覧で戻らないように）
            onMutate: () => {
                cancelLists([from.id, to.id]);
                ctx.sessions.moveLocally(sessionId, from.id, to.id);
            },
            mutationFn: async () => {
                if (!isDemo) {
                    await api.post(`/api/projects/${from.id}/sessions/${sessionId}/move`, { to: to.id });
                }
            },
            onSuccess: async () => {
                if (!isDemo) {
                    await ctx.sessions.reloadAfterMove(sessionId, from.id, to.id);
                }
                toast.success(`「${session.title}」を${to.name}へ移しました`);
            },
            // 戻すときは逆向きに移す（待っている間に届いた、ほかのセッションの変更は消さない）
            onError: (e) => {
                ctx.sessions.moveLocally(sessionId, to.id, from.id);
                toast.error(`「${session.title}」を移せません: ${e.message}`);
            },
        },
        undefined,
    ).catch(() => {});
}

export async function reorderProjects(ctx: ActionContext, ids: string[]) {
    const { getState: get, setState: set } = ctx.store;
    const tracker = reorderTracker(ctx.store);
    const show = (order: ProjectOrder) => {
        ctx.sessions.sortProjectsBy(order.ids);
        set((s) => ({ settings: { ...s.settings, projectOrder: order.projectOrder } }));
    };
    await runMutation(
        {
            // 先に画面を入れ替えておく（保存を待つと、離した瞬間に元の位置へ戻って見える）
            onMutate: () => {
                cancelLists([]);
                const before = { ids: readProjectInfos().map((p) => p.id), projectOrder: get().settings.projectOrder };
                const seq = tracker.start(before, { ids, projectOrder: ids });
                show({ ids, projectOrder: ids });
                return seq;
            },
            mutationFn: async () => {
                if (!isDemo) {
                    await api.patch('/api/settings', { projectOrder: ids });
                }
            },
            onSuccess: (_d, _v, seq) => tracker.succeed(seq),
            // 保存できなかったので戻す。あとから並べ替えた並びを出しているなら、そのまま（#361）
            onError: (e, _v, seq) => {
                toast.error(`プロジェクトの並びを保存できません: ${e.message}`);
                const back = seq === undefined ? null : tracker.fail(seq);
                if (back) {
                    show(back);
                }
            },
        },
        undefined,
    ).catch(() => {});
}
