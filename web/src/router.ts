// 画面の URL（#177）。開いているセッション・プロジェクト・設定モーダルを URL に出し、
// 戻る・進む・再読み込み・URL を直接開く、のどれでも同じ画面を開く
//
//   /                    何も選んでいない
//   /p/<プロジェクトの UUID>/new  新規セッション画面（/p/<UUID> も同じ）
//   /s/<セッションの UUID>       セッション。プロジェクトを入れないので、別のプロジェクトへ移しても変わらない
//   /settings/<ページ>          設定モーダル。閉じたら開く前の URL に戻る
//
// UUID のないもの（古いサーバー・?demo のダミーデータ）は、UUID の代わりに今の ID を使う
import type { Project } from '@/types';

export type Route =
    | { kind: 'home' }
    | { kind: 'project'; key: string }
    | { kind: 'session'; key: string }
    | { kind: 'settings'; page: string }
    | { kind: 'unknown' };

export function parsePath(pathname: string): Route {
    const parts = pathname
        .split('/')
        .filter((p) => p !== '')
        .map(decodeURIComponent);
    if (parts.length === 0) {
        return { kind: 'home' };
    }
    const [head, key, rest] = parts;
    if (head === 's' && key && parts.length === 2) {
        return { kind: 'session', key };
    }
    if (head === 'p' && key && (parts.length === 2 || (parts.length === 3 && rest === 'new'))) {
        return { kind: 'project', key };
    }
    if (head === 'settings' && parts.length <= 2) {
        return { kind: 'settings', page: key ?? '' };
    }
    return { kind: 'unknown' };
}

export function routePath(route: Route): string {
    switch (route.kind) {
        case 'project':
            return `/p/${encodeURIComponent(route.key)}/new`;
        case 'session':
            return `/s/${encodeURIComponent(route.key)}`;
        case 'settings':
            return `/settings/${encodeURIComponent(route.page)}`;
        default:
            return '/';
    }
}

type Selection = { projectId: string | null; sessionId: string | null };

// 選んでいるものの URL
export function selectionRoute(projects: Project[], selection: Selection): Route {
    const project = projects.find((p) => p.id === selection.projectId);
    if (!project) {
        return { kind: 'home' };
    }
    const session = project.sessions.find((s) => s.id === selection.sessionId);
    if (session) {
        return { kind: 'session', key: session.uuid ?? session.id };
    }
    return { kind: 'project', key: project.uuid ?? project.id };
}

// URL の UUID（か ID）から、選ぶものを引く。見つからなければ null
export function findRoute(projects: Project[], route: Route): Selection | null {
    if (route.kind === 'home' || route.kind === 'settings') {
        return { projectId: null, sessionId: null };
    }
    if (route.kind === 'project') {
        const project = projects.find((p) => p.uuid === route.key || p.id === route.key);
        return project ? { projectId: project.id, sessionId: null } : null;
    }
    if (route.kind === 'session') {
        for (const p of projects) {
            const session = p.sessions.find((s) => s.uuid === route.key || s.id === route.key);
            if (session) {
                return { projectId: p.id, sessionId: session.id };
            }
        }
    }
    return null;
}

// router が見る store の一部（store.ts を読み込むと循環するので、形だけ決めておく）
export type RouterState = {
    projects: Project[];
    projectsLoaded: boolean;
    selection: Selection;
    settingsOpen: boolean;
    settingsPage: string;
    notFound: boolean;
};

export type RouterStore = {
    getState: () => RouterState;
    subscribe: (listener: (state: RouterState) => void) => () => void;
    setState: (partial: Partial<RouterState>) => void;
    // セッションか新規セッション画面を開く（中身の読み込みも store の操作に任せる）
    open: (selection: Selection) => void;
};

function sameSelection(a: Selection, b: Selection) {
    return a.projectId === b.projectId && a.sessionId === b.sessionId;
}

// 次の URL の変化を、履歴を増やさずに置き換える（録音を始めて、新規セッション画面がそのセッションになったとき）
let replaceNext = false;
export function replaceUrlNext() {
    replaceNext = true;
}

// URL を画面に合わせ続ける。止める関数を返す
export function startRouter(store: RouterStore) {
    // 開いたときの URL。プロジェクトの一覧を読み込むまで、選べるかが分からないので取っておく
    let pending: Route | null = null;
    // URL を画面に反映している途中（途中の状態で URL を書かないように）
    let applying = false;
    // 今の URL が表しているもの。履歴を足すか置き換えるかを、これと比べて決める
    let shown = { selection: store.getState().selection, settingsOpen: false };
    // 設定モーダルを開いたときに履歴を足したか（閉じたら戻る）
    let settingsPushed = false;

    // URL を画面に反映する。プロジェクトの一覧がまだなら、読み込んでから
    function apply(route: Route) {
        const s = store.getState();
        if (route.kind !== 'settings' && !s.projectsLoaded) {
            pending = route;
            return;
        }
        pending = null;
        applying = true;
        try {
            if (route.kind === 'settings') {
                // 設定モーダルの後ろは今の画面のまま（直接開いたときは何も選んでいない画面）
                store.setState({ settingsOpen: true, settingsPage: route.page, notFound: false });
            } else {
                const selection = findRoute(s.projects, route);
                if (selection) {
                    store.setState({ settingsOpen: false, notFound: false });
                    store.open(selection);
                } else {
                    store.setState({
                        settingsOpen: false,
                        selection: { projectId: null, sessionId: null },
                        notFound: true,
                    });
                }
            }
        } finally {
            applying = false;
        }
        const state = store.getState();
        shown = { selection: state.selection, settingsOpen: state.settingsOpen };
        // /p/<UUID> を /p/<UUID>/new にするなど、URL の形をそろえる（履歴は増やさない）
        replaceNext = true;
        write(state);
    }

    function write(state: RouterState) {
        if (pending !== null || applying || state.notFound) {
            return;
        }
        const route = state.settingsOpen
            ? ({ kind: 'settings', page: state.settingsPage } as const)
            : selectionRoute(state.projects, state.selection);
        const closingSettings = shown.settingsOpen && !state.settingsOpen;
        const same = sameSelection(shown.selection, state.selection) && shown.settingsOpen === state.settingsOpen;
        shown = { selection: state.selection, settingsOpen: state.settingsOpen };
        const path = routePath(route);
        const replace = replaceNext;
        replaceNext = false;
        if (path === window.location.pathname) {
            return;
        }
        const url = path + window.location.search;
        if (closingSettings && settingsPushed) {
            // 設定モーダルを閉じた。開く前の URL に戻る（戻ったあと popstate でもう一度合わせる）
            settingsPushed = false;
            window.history.back();
            return;
        }
        // UUID が届いただけ（同じものを選んだまま）・設定モーダルの中のページの切り替え・録音を始めたとき・
        // URL から直接開いた設定モーダルを閉じたときは、履歴を増やさない
        if (replace || same || closingSettings) {
            window.history.replaceState(null, '', url);
            return;
        }
        window.history.pushState(null, '', url);
        if (state.settingsOpen) {
            settingsPushed = true;
        }
    }

    const unsubscribe = store.subscribe((state) => {
        if (applying) {
            return;
        }
        if (pending !== null) {
            if (state.projectsLoaded) {
                apply(pending);
            }
            return;
        }
        // 「見つかりません」を出している間に別のものを選んだら、消してからその URL にする
        if (state.notFound && (!sameSelection(state.selection, shown.selection) || state.settingsOpen)) {
            store.setState({ notFound: false });
            return;
        }
        write(state);
    });

    const onPopState = () => {
        settingsPushed = false;
        apply(parsePath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    apply(parsePath(window.location.pathname));

    return () => {
        unsubscribe();
        window.removeEventListener('popstate', onPopState);
    };
}
