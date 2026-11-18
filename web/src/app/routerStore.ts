// router（#177）が見るストア。プロジェクトの一覧はキャッシュにあるので（#361）、ストアとキャッシュの両方の変化を知らせる
import { queryClient } from '@/app/query';
import type { RouterState, RouterStore } from '@/app/router';
import { readProjects } from '@/app/sessionData';
import { useAppStore } from '@/app/store';

function routerState(): RouterState {
    const s = useAppStore.getState();
    return { ...s, projects: readProjects(s) };
}

export const routerStore: RouterStore = {
    getState: routerState,
    subscribe: (listener) => {
        const offStore = useAppStore.subscribe(() => listener(routerState()));
        const offCache = queryClient.getQueryCache().subscribe(() => listener(routerState()));
        return () => {
            offStore();
            offCache();
        };
    },
    setState: useAppStore.setState,
    open: ({ projectId, sessionId }) => {
        const s = useAppStore.getState();
        if (projectId && sessionId) {
            s.selectSession(projectId, sessionId);
        } else if (projectId) {
            s.openNewSession(projectId);
        } else {
            useAppStore.setState({ selection: { projectId: null, sessionId: null } });
        }
    },
};
