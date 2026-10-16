import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStore } from 'zustand/vanilla';

import {
    type RouterState,
    findRoute,
    parsePath,
    replaceUrlNext,
    routePath,
    selectionRoute,
    startRouter,
} from '@/router';
import type { Project } from '@/types';

const P = '11111111-1111-4111-8111-111111111111';
const S1 = '22222222-2222-4222-8222-222222222222';
const S2 = '33333333-3333-4333-8333-333333333333';

function session(id: string, uuid?: string) {
    return { id, uuid, title: id, startedAt: '', status: 'done' as const, transcript: [], summaries: [] };
}

const projects: Project[] = [
    {
        id: 'D--work-meetings-a1b2c3',
        uuid: P,
        name: 'meetings',
        path: 'D:\\work\\meetings',
        sessions: [session('20261009-100000', S1), session('20261009-143012', S2)],
    },
    // UUID のない古いサーバー・デモのデータ
    { id: 'demo', name: 'demo', path: '', sessions: [session('20261001-090000')] },
];

describe('parsePath と routePath', () => {
    it.each([
        ['/', { kind: 'home' }],
        [`/s/${S1}`, { kind: 'session', key: S1 }],
        [`/p/${P}/new`, { kind: 'project', key: P }],
        [`/p/${P}`, { kind: 'project', key: P }],
        ['/settings/ollama', { kind: 'settings', page: 'ollama' }],
        ['/settings', { kind: 'settings', page: '' }],
        ['/x/y', { kind: 'unknown' }],
        [`/s/${S1}/more`, { kind: 'unknown' }],
    ])('%s', (path, route) => {
        expect(parsePath(path)).toEqual(route);
    });

    it('URL に戻すと同じものを指す', () => {
        for (const path of ['/', `/s/${S1}`, `/p/${P}/new`, '/settings/display']) {
            expect(routePath(parsePath(path))).toBe(path);
        }
    });
});

describe('selectionRoute と findRoute', () => {
    it('セッションは UUID で、プロジェクトを入れない', () => {
        const route = selectionRoute(projects, { projectId: projects[0].id, sessionId: '20261009-143012' });
        expect(routePath(route)).toBe(`/s/${S2}`);
        expect(findRoute(projects, route)).toEqual({ projectId: projects[0].id, sessionId: '20261009-143012' });
    });

    it('セッションを選んでいなければ新規セッション画面', () => {
        expect(routePath(selectionRoute(projects, { projectId: projects[0].id, sessionId: null }))).toBe(`/p/${P}/new`);
    });

    it('UUID がなければ ID を使う', () => {
        const route = selectionRoute(projects, { projectId: 'demo', sessionId: '20261001-090000' });
        expect(routePath(route)).toBe('/s/20261001-090000');
        expect(findRoute(projects, route)).toEqual({ projectId: 'demo', sessionId: '20261001-090000' });
    });

    it('知らない UUID は null', () => {
        expect(findRoute(projects, { kind: 'session', key: 'nothing' })).toBeNull();
        expect(findRoute(projects, { kind: 'project', key: 'nothing' })).toBeNull();
        expect(findRoute(projects, { kind: 'unknown' })).toBeNull();
    });
});

describe('startRouter', () => {
    let stop: () => void;

    function setup(path: string, loaded = true) {
        window.history.replaceState(null, '', path);
        const store = createStore<RouterState>(() => ({
            projects: loaded ? projects : [],
            projectsLoaded: loaded,
            selection: { projectId: null, sessionId: null },
            settingsOpen: false,
            settingsPage: 'whisper',
            notFound: false,
        }));
        stop = startRouter({
            getState: store.getState,
            subscribe: store.subscribe,
            setState: store.setState,
            open: (selection) => store.setState({ selection }),
        });
        return store;
    }

    // popstate は同期では来ないので、戻る・進むは自分で知らせる
    function back() {
        window.history.back();
        return new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
    }

    beforeEach(() => {
        window.history.replaceState(null, '', '/');
    });
    afterEach(() => {
        stop();
    });

    it('URL のセッションを開く（再読み込み・別の端末で開いたとき）', () => {
        const store = setup(`/s/${S1}`);
        expect(store.getState().selection).toEqual({ projectId: projects[0].id, sessionId: '20261009-100000' });
        expect(window.location.pathname).toBe(`/s/${S1}`);
    });

    it('一覧を読み込むまで待ってから開く', () => {
        const store = setup(`/s/${S2}`, false);
        expect(store.getState().selection.sessionId).toBeNull();
        expect(window.location.pathname).toBe(`/s/${S2}`);
        store.setState({ projects, projectsLoaded: true });
        expect(store.getState().selection.sessionId).toBe('20261009-143012');
    });

    it('見つからなければ「見つかりません」にして、URL はそのまま', () => {
        const store = setup('/s/44444444-4444-4444-8444-444444444444');
        expect(store.getState().notFound).toBe(true);
        expect(window.location.pathname).toBe('/s/44444444-4444-4444-8444-444444444444');
        // 別のものを開いたら消える
        store.setState({ selection: { projectId: projects[0].id, sessionId: '20261009-100000' } });
        expect(store.getState().notFound).toBe(false);
        expect(window.location.pathname).toBe(`/s/${S1}`);
    });

    it('選ぶと履歴が増え、戻ると前のセッションに戻る', async () => {
        const store = setup(`/s/${S1}`);
        const length = window.history.length;
        store.setState({ selection: { projectId: projects[0].id, sessionId: '20261009-143012' } });
        expect(window.location.pathname).toBe(`/s/${S2}`);
        expect(window.history.length).toBe(length + 1);

        await back();
        expect(window.location.pathname).toBe(`/s/${S1}`);
        expect(store.getState().selection.sessionId).toBe('20261009-100000');
    });

    it('録音を始めて新規セッション画面がそのセッションになったら、履歴を増やさずに置き換える', () => {
        const store = setup(`/p/${P}`);
        // /p/<UUID> は /p/<UUID>/new にそろえる
        expect(window.location.pathname).toBe(`/p/${P}/new`);
        const length = window.history.length;
        replaceUrlNext();
        store.setState({ selection: { projectId: projects[0].id, sessionId: '20261009-143012' } });
        expect(window.location.pathname).toBe(`/s/${S2}`);
        expect(window.history.length).toBe(length);
    });

    it('設定モーダルは URL に出て、閉じると開く前の URL に戻る', async () => {
        const store = setup(`/s/${S1}`);
        store.setState({ settingsOpen: true });
        expect(window.location.pathname).toBe('/settings/whisper');
        store.setState({ settingsPage: 'display' });
        expect(window.location.pathname).toBe('/settings/display');

        store.setState({ settingsOpen: false });
        await new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
        expect(window.location.pathname).toBe(`/s/${S1}`);
        expect(store.getState().selection.sessionId).toBe('20261009-100000');
    });

    it('戻るで設定モーダルを閉じ、進むで開く', async () => {
        const store = setup(`/s/${S1}`);
        store.setState({ settingsOpen: true, settingsPage: 'ollama' });
        await back();
        expect(store.getState().settingsOpen).toBe(false);
        window.history.forward();
        await new Promise<void>((resolve) => window.addEventListener('popstate', () => resolve(), { once: true }));
        expect(store.getState().settingsOpen).toBe(true);
        expect(store.getState().settingsPage).toBe('ollama');
    });

    it('URL から直接開いた設定モーダルを閉じると、何も選んでいない画面になる', () => {
        const store = setup('/settings/storage');
        expect(store.getState().settingsOpen).toBe(true);
        expect(store.getState().settingsPage).toBe('storage');
        store.setState({ settingsOpen: false });
        expect(window.location.pathname).toBe('/');
    });

    it('?demo などのクエリは残す', () => {
        const store = setup(`/s/${S1}?demo`);
        store.setState({ selection: { projectId: projects[0].id, sessionId: '20261009-143012' } });
        expect(window.location.pathname + window.location.search).toBe(`/s/${S2}?demo`);
    });
});
