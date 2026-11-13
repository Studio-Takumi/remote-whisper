import 'fake-indexeddb/auto';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ProjectJson, api } from '@/api';
import { connection } from '@/connection';
import { projectsQuery } from '@/data';
import type { ServerMessage } from '@/protocol';
import { queryClient, queryKeys } from '@/query';
import { defaultSettings } from '@/settings';
import { useAppStore } from '@/store';

// プロジェクトの一覧を TanStack Query のキャッシュを通して取る（#330 の 1 段目）

const selection = { contextSet: null, useHotwords: true, useContext: true };
const project = (id: string): ProjectJson => ({ id, name: id, path: `/work/${id}`, selection });

// キャッシュにあるプロジェクトの一覧の ID
const cachedIds = () => queryClient.getQueryData(projectsQuery.queryKey)?.map((p) => p.id);

// サーバーの返事。/api/projects の返事は projects を差し替えて変える
let projects: ProjectJson[] = [];
let projectOrder: string[] = [];
let down = false;

function mockServer() {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
        if (down) {
            throw new ApiError(0, 'ホストにつながりません');
        }
        if (path === '/api/projects') {
            return projects;
        }
        if (path === '/api/settings') {
            return { ...defaultSettings, projectOrder };
        }
        // セッションの一覧・参考資料セットの一覧は空
        return [];
    });
}

function projectListCalls(get: ReturnType<typeof mockServer>) {
    return get.mock.calls.filter(([path]) => path === '/api/projects').length;
}

// WebSocket はつながずに、サーバーからのメッセージを手で流す
let receive: (m: ServerMessage) => void = () => {};

beforeAll(() => {
    vi.spyOn(connection, 'start').mockImplementation(() => {});
    vi.spyOn(connection, 'onStateChange').mockImplementation(() => () => {});
    vi.spyOn(connection, 'subscribe').mockImplementation((listener) => {
        receive = listener;
        return () => {};
    });
    useAppStore.getState().connectServer();
});

beforeEach(() => {
    queryClient.clear();
    useAppStore.setState({ projects: [], projectsLoaded: false });
    projects = [project('a'), project('b')];
    projectOrder = [];
    down = false;
});

afterEach(() => {
    vi.mocked(api.get).mockRestore?.();
});

// 届いたメッセージの処理（設定の取り直しなど）が終わるのを待つ
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('プロジェクトの一覧', () => {
    it('取った一覧をキャッシュとストアに入れる', async () => {
        mockServer();
        await useAppStore.getState().loadProjects();
        expect(cachedIds()).toEqual(['a', 'b']);
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['a', 'b']);
        expect(useAppStore.getState().projectsLoaded).toBe(true);
    });

    it('同時に取り直しを頼まれたら、一覧は 1 回だけ取る', async () => {
        const get = mockServer();
        await Promise.all([useAppStore.getState().loadProjects(), useAppStore.getState().loadProjects()]);
        expect(projectListCalls(get)).toBe(1);
    });

    it('前に取っていても、取り直しを頼まれたら取り直す', async () => {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        projects = [project('a'), project('b'), project('c')];
        await useAppStore.getState().loadProjects();
        expect(projectListCalls(get)).toBe(2);
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('ホストが落ちていたら、今までどおりエラーを出して前の一覧のまま', async () => {
        mockServer();
        await useAppStore.getState().loadProjects();
        const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
        down = true;
        await useAppStore.getState().loadProjects();
        expect(error).toHaveBeenCalledWith('プロジェクトを読み込めません: ホストにつながりません');
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['a', 'b']);
        // 取り直しを重ねない
        expect(queryClient.getQueryState(queryKeys.projects())?.status).toBe('error');
        error.mockRestore();
    });
});

describe('WebSocket の通知', () => {
    it('projectOrder: キャッシュとストアの一覧を並べ直す（一覧は取り直さない）', async () => {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        projectOrder = ['b', 'a'];
        receive({ type: 'projectOrder' });
        await flush();
        expect(cachedIds()).toEqual(['b', 'a']);
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['b', 'a']);
        expect(projectListCalls(get)).toBe(1);
    });

    it('projectOrder: 知らないプロジェクトがあれば、一覧を取り直してキャッシュを新しくする', async () => {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        projects = [project('c'), project('a'), project('b')];
        projectOrder = ['c', 'a', 'b'];
        receive({ type: 'projectOrder' });
        await vi.waitFor(() => expect(projectListCalls(get)).toBe(2));
        await vi.waitFor(() => expect(cachedIds()).toEqual(['c', 'a', 'b']));
        await vi.waitFor(() => expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['c', 'a', 'b']));
    });
});
