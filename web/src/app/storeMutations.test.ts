import 'fake-indexeddb/auto';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ProjectJson, type SessionJson, api } from '@/api/api';
import { connection } from '@/api/connection';
import { transcriptQuery } from '@/api/transcripts';
import { queryClient } from '@/app/query';
import { readProjects, readSession } from '@/app/sessionData';
import { useAppStore } from '@/app/store';
import { defaultSettings } from '@/features/settings/settings';

// 楽観的更新の巻き戻しと、待っている間の一覧の取り直し（#361 で直したもの。#360 のレビューの気づき）

const selection = { contextSet: null, useHotwords: true, useContext: true };
const project = (id: string): ProjectJson => ({ id, name: id, path: `/work/${id}`, selection });
const session = (id: string): SessionJson => ({
    id,
    title: '週次の定例',
    status: 'done',
    startedAt: '2026-11-01T10:00:00+09:00',
    endedAt: '2026-11-01T11:00:00+09:00',
    contextSet: null,
    files: { recording: true, transcript: true, finalTranscripts: 0, summaries: 0, liveSummary: false },
});

// サーバーの返事（パスごと）。関数を入れたら呼んだ結果を返す
let responses: Record<string, unknown> = {};

function mockServer() {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
        if (path.endsWith('/context-sets')) {
            return [];
        }
        const r = responses[path];
        return typeof r === 'function' ? r() : structuredClone(r);
    });
}

// 返事を止めておき、あとで返す
function hold(path: string) {
    let release: () => void = () => {};
    const value = structuredClone(responses[path]);
    responses[path] = () => new Promise((r) => (release = () => r(value)));
    return () => release();
}

// 返事を待たせたままにする操作
function pending(method: 'post' | 'patch') {
    const settle: { resolve: (v?: unknown) => void; reject: (e: Error) => void }[] = [];
    vi.spyOn(api, method).mockImplementation(() => new Promise((resolve, reject) => settle.push({ resolve, reject })));
    return settle;
}

const ids = () => readProjects(useAppStore.getState()).map((p) => p.id);
const sessionIds = (pid: string) =>
    readProjects(useAppStore.getState())
        .find((p) => p.id === pid)!
        .sessions.map((x) => x.id);
const opened = () => readSession(useAppStore.getState(), 's1')!;

beforeAll(() => {
    vi.spyOn(connection, 'start').mockImplementation(() => {});
    vi.spyOn(connection, 'send').mockImplementation(() => {});
    vi.spyOn(connection, 'onStateChange').mockImplementation(() => () => {});
    vi.spyOn(connection, 'subscribe').mockImplementation(() => () => {});
    useAppStore.getState().connectServer();
});

beforeEach(() => {
    queryClient.clear();
    useAppStore.setState({
        localSessions: [],
        loadedSessions: {},
        projectsLoaded: false,
        selection: { projectId: null, sessionId: null },
        settings: { ...defaultSettings, projectOrder: [] },
        settingsLoaded: true,
    });
    responses = {
        '/api/projects': [project('a'), project('b'), project('c')],
        '/api/projects/a/sessions': [session('s1')],
        '/api/projects/b/sessions': [],
        '/api/projects/c/sessions': [],
        '/api/projects/a/sessions/s1/transcript': {
            lines: [
                { time: '00:00:01', text: 'りりーす計画' },
                { time: '00:00:05', text: '始めます' },
            ],
            meta: { pickedTerms: [], manualTerms: [], corrections: [] },
        },
    };
    vi.spyOn(toast, 'error').mockImplementation(() => '');
    vi.spyOn(toast, 'success').mockImplementation(() => '');
    mockServer();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(connection, 'send').mockImplementation(() => {});
});

describe('待っている間に一覧の取り直しが返っても、操作の結果を戻さない', () => {
    it('セッションの移動', async () => {
        await useAppStore.getState().loadProjects();
        const release = hold('/api/projects/a/sessions');
        const reloading = useAppStore.getState().loadProjects();
        await vi.waitFor(() =>
            expect(vi.mocked(api.get).mock.calls.filter(([p]) => p === '/api/projects/a/sessions')).toHaveLength(2),
        );
        pending('post');
        void useAppStore.getState().moveSession('a', 's1', 'b');
        expect(sessionIds('b')).toEqual(['s1']);
        // 移す前に始めた取り直しの返事（まだ a にある）
        release();
        await reloading;
        expect(sessionIds('a')).toEqual([]);
        expect(sessionIds('b')).toEqual(['s1']);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('プロジェクトの並べ替え', async () => {
        await useAppStore.getState().loadProjects();
        const release = hold('/api/projects');
        const reloading = useAppStore.getState().loadProjects();
        pending('patch');
        void useAppStore.getState().reorderProjects(['c', 'b', 'a']);
        release();
        await reloading;
        expect(ids()).toEqual(['c', 'b', 'a']);
        expect(toast.error).not.toHaveBeenCalled();
    });
});

describe('並べ替えを続けて 2 回して、1 回目だけ失敗する', () => {
    it('2 回目が保存できなかったら、保存できた 1 回目の並びに戻す', async () => {
        await useAppStore.getState().loadProjects();
        const saves = pending('patch');
        void useAppStore.getState().reorderProjects(['b', 'a', 'c']);
        void useAppStore.getState().reorderProjects(['c', 'b', 'a']);
        await vi.waitFor(() => expect(saves).toHaveLength(2));
        saves[0].resolve();
        saves[1].reject(new ApiError(0, 'ホストにつながりません'));
        await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(ids()).toEqual(['b', 'a', 'c']);
        expect(useAppStore.getState().settings.projectOrder).toEqual(['b', 'a', 'c']);
    });

    it('2 回目の並びのまま', async () => {
        await useAppStore.getState().loadProjects();
        const saves = pending('patch');
        void useAppStore.getState().reorderProjects(['b', 'a', 'c']);
        void useAppStore.getState().reorderProjects(['c', 'b', 'a']);
        await vi.waitFor(() => expect(saves).toHaveLength(2));
        saves[0].reject(new ApiError(0, 'ホストにつながりません'));
        await vi.waitFor(() => expect(toast.error).toHaveBeenCalled());
        expect(ids()).toEqual(['c', 'b', 'a']);
        expect(useAppStore.getState().settings.projectOrder).toEqual(['c', 'b', 'a']);
        saves[1].resolve();
    });
});

describe('置き換えの巻き戻し', () => {
    it('待っている間にほかから書き換わった行は、戻さない', async () => {
        await useAppStore.getState().loadProjects();
        useAppStore.getState().selectSession('a', 's1');
        await vi.waitFor(() => expect(opened().loaded).toBe(true));
        const saves = pending('post');
        const done = useAppStore.getState().addCorrection('s1', { from: 'りりーす', to: 'リリース', line: null });
        expect(opened().transcript.map((x) => x.text)).toEqual(['リリース計画', '始めます']);
        // 待っている間に、同じ添字の行がほかの置き換えで変わった
        queryClient.setQueryData(transcriptQuery('a', 's1').queryKey, (t) =>
            t ? { ...t, lines: [t.lines[0], { time: '00:00:05', text: '始めました' }] } : t,
        );
        await vi.waitFor(() => expect(saves).toHaveLength(1));
        saves[0].reject(new ApiError(400, '置き換えられない語です'));
        expect(await done).toBe(false);
        expect(opened().transcript.map((x) => x.text)).toEqual(['りりーす計画', '始めました']);
    });
});
