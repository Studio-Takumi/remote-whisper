// プロジェクトとセッションの一覧を取る・開く・作る・移す・並べ替える（spec/api.md 7.1）
import { toast } from 'sonner';

import { type ProjectJson, api } from '@/api/api';
import { fetchProjects, isDemo, mergeProjects } from '@/api/data';
import type { ActionContext } from '@/app/actionContext';
import { runMutation } from '@/app/query';
import { currentProject, currentSession } from '@/app/selectors';
import { refreshContextSets } from '@/features/materials/contextSetCache';

export async function loadProjects(ctx: ActionContext) {
    const { getState: get, setState: set } = ctx.store;
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
                [s.recordingSessionId, s.generating?.sessionId, ctx.recorder.stoppedWhileOffline].filter(
                    (id): id is string => !!id && id !== ctx.sessions.releasing,
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
        await ctx.sessions.loadSession(project.id, session);
    }
}

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
    const session = get()
        .projects.find((p) => p.id === projectId)
        ?.sessions.find((x) => x.id === sessionId);
    if (!isDemo && session && !session.loaded) {
        void ctx.sessions.loadSession(projectId, session);
    }
}

export function showRecordingSession(ctx: ActionContext) {
    const get = ctx.store.getState;
    const sessionId = get().recordingSessionId;
    const project = get().projects.find((p) => p.sessions.some((x) => x.id === sessionId));
    if (sessionId && project) {
        get().selectSession(project.id, sessionId);
    }
}

export async function moveSession(ctx: ActionContext, fromProjectId: string, sessionId: string, toProjectId: string) {
    const get = ctx.store.getState;
    const from = get().projects.find((p) => p.id === fromProjectId);
    const to = get().projects.find((p) => p.id === toProjectId);
    const session = from?.sessions.find((x) => x.id === sessionId);
    if (!from || !to || !session || from.id === to.id) {
        return;
    }
    await runMutation(
        {
            // 先に画面とキャッシュで移しておく（失敗したら戻す）
            onMutate: () => ctx.sessions.moveLocally(sessionId, from.id, to.id),
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
    await runMutation(
        {
            // 先に画面を入れ替えておく（保存を待つと、離した瞬間に元の位置へ戻って見える）
            onMutate: () => {
                const before = {
                    ids: get().projects.map((p) => p.id),
                    projectOrder: get().settings.projectOrder,
                };
                ctx.sessions.sortProjectsBy(ids);
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
                    ctx.sessions.sortProjectsBy(before.ids);
                    set((s) => ({ settings: { ...s.settings, projectOrder: before.projectOrder } }));
                }
            },
        },
        undefined,
    ).catch(() => {});
}
