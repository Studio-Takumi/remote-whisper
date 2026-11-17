// 参考資料セットを作る・使うセットを選ぶ（spec/flows.md 6.6 節）
import { toast } from 'sonner';

import { ApiError, type ProjectJson, api } from '@/api/api';
import { isDemo, projectsQuery, toSelection } from '@/api/data';
import type { ContextSelection, ContextSet } from '@/api/types';
import type { ActionContext } from '@/app/actionContext';
import type { AppState } from '@/app/appState';
import { queryClient, runMutation } from '@/app/query';
import { currentContextSelection, currentProject } from '@/app/selectors';
import { cachedContextSets, updateCachedContextSets } from '@/features/materials/contextSetCache';
import { newId } from '@/lib/time';

// 手元の上書きを消した選択（保存できた・できなかったとき）
function clearOverride(s: AppState, pid: string) {
    const selections = { ...s.contextSelections };
    delete selections[pid];
    return selections;
}

// 使うセットと、用語リスト・コンテキストを使うかを保存する（PATCH .../selection）。録音中は 409
export async function changeContextSelection(ctx: ActionContext, next: ContextSelection) {
    const { getState: get, setState: set } = ctx.store;
    const project = currentProject(get());
    if (!project) {
        return;
    }
    // 保存するまでの間だけ、手元の選択（contextSelections）で上書きして出す
    const pid = project.id;
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
            // （ほかの端末で変えた選択も、取り直しで出るように）。キャッシュのプロジェクトの一覧に入れる
            onSuccess: (saved) => {
                const selection = toSelection(saved);
                queryClient.setQueryData(projectsQuery.queryKey, (list) =>
                    list?.map((p) => (p.id === pid ? { ...p, selection } : p)),
                );
                set((s) => ({ contextSelections: clearOverride(s, pid) }));
            },
            // 保存できなければ、上書きを消して元（サーバーの選択）に戻す
            onError: (e) => {
                set((s) => ({ contextSelections: clearOverride(s, pid) }));
                if (e instanceof ApiError && e.status === 409) {
                    toast.error('録音中は参考資料を変えられません');
                } else {
                    toast.error(`参考資料の選択を保存できません: ${e.message}`);
                }
            },
        },
        undefined,
    ).catch(() => {});
}

// 資料を送ってセットの作成を始める（POST .../context-sets）。できたかは contextSet で届く。
// 同じ資料の組み合わせのセットがあれば、サーバーが使い回す（spec/flows.md 6.6 節）
export async function createContextSet(ctx: ActionContext, materials: string[]) {
    const get = ctx.store.getState;
    const s = get();
    const project = currentProject(s);
    if (!project) {
        return;
    }
    const pid = project.id;
    const selection = currentContextSelection(s, cachedContextSets(pid));
    if (!isDemo) {
        try {
            const created = await api.post<ContextSet & { reused: boolean }>(`/api/projects/${pid}/context-sets`, {
                materials,
            });
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
        updateCachedContextSets(pid, (sets) => sets.map((x) => (x.id === created.id ? { ...x, status: 'ready' } : x)));
        toast.success('参考資料ができました');
    }, 4000);
}
