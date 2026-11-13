import 'fake-indexeddb/auto';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ProjectJson, type SessionJson, api } from '@/api';
import { connection } from '@/connection';
import { contextSetsQuery, finalTranscriptQuery, finalTranscriptsQuery, projectsQuery, sessionsQuery } from '@/data';
import type { ServerMessage } from '@/protocol';
import { queryClient, queryKeys } from '@/query';
import { defaultSettings } from '@/settings';
import { cachedContextSets, useAppStore } from '@/store';
import type { ContextSet } from '@/types';

// プロジェクトの一覧（#330 の 1 段目）・セッションの一覧と参考資料セットの一覧（2 段目）・
// 文字起こしと最終の文字起こし（3 段目）を TanStack Query のキャッシュを通して取る

const selection = { contextSet: null, useHotwords: true, useContext: true };
const project = (id: string): ProjectJson => ({ id, name: id, path: `/work/${id}`, selection });
const session = (id: string, title: string): SessionJson => ({
    id,
    title,
    status: 'done',
    startedAt: '2026-11-01T10:00:00+09:00',
    endedAt: '2026-11-01T11:00:00+09:00',
    contextSet: null,
    files: { recording: true, transcript: true, summaries: 0, liveSummary: false },
});

// キャッシュにあるプロジェクトの一覧の ID
const cachedIds = () => queryClient.getQueryData(projectsQuery.queryKey)?.map((p) => p.id);

// サーバーの返事。/api/projects の返事は projects を差し替えて変える
let projects: ProjectJson[] = [];
let projectOrder: string[] = [];
// プロジェクトごとのセッションの一覧と参考資料セットの一覧（ないプロジェクトは空）
let sessions: Record<string, SessionJson[]> = {};
let contextSets: Record<string, ContextSet[]> = {};
let down = false;
// 参考資料セットの一覧だけ取れない
let contextSetsDown = false;
// そのほかのパスの返事（文字起こしなど。3 段目）
let other: Record<string, unknown> = {};

function mockServer() {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
        if (down) {
            throw new ApiError(0, 'ホストにつながりません');
        }
        if (path in other) {
            if (other[path] instanceof Error) {
                throw other[path];
            }
            return structuredClone(other[path]);
        }
        if (path === '/api/projects') {
            return projects;
        }
        if (path === '/api/settings') {
            return { ...defaultSettings, projectOrder };
        }
        const m = path.match(/^\/api\/projects\/([^/]+)\/(sessions|context-sets)$/);
        if (m?.[2] === 'sessions') {
            return sessions[m[1]] ?? [];
        }
        if (m?.[2] === 'context-sets') {
            if (contextSetsDown) {
                throw new ApiError(500, 'context-sets');
            }
            return contextSets[m[1]] ?? [];
        }
        throw new Error(`unexpected GET ${path}`);
    });
}

function calls(get: ReturnType<typeof mockServer>, path: string) {
    return get.mock.calls.filter(([p]) => p === path).length;
}

function projectListCalls(get: ReturnType<typeof mockServer>) {
    return calls(get, '/api/projects');
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
    useAppStore.setState({
        projects: [],
        projectsLoaded: false,
        selection: { projectId: null, sessionId: null },
        contextSelections: {},
    });
    projects = [project('a'), project('b')];
    projectOrder = [];
    sessions = {};
    contextSets = {};
    other = {};
    down = false;
    contextSetsDown = false;
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

    it('title: キャッシュのセッションの一覧のタイトルも書き換える（取り直さない）', async () => {
        sessions = { a: [session('s1', '仮のタイトル')] };
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        receive({ type: 'title', session: 's1', title: '週次の定例', provisional: true });
        expect(queryClient.getQueryData(sessionsQuery('a').queryKey)?.[0].title).toBe('週次の定例');
        expect(useAppStore.getState().projects[0].sessions[0].title).toBe('週次の定例');
        expect(calls(get, '/api/projects/a/sessions')).toBe(1);
    });

    it('contextSet: 知っているセットは、キャッシュの状態を書き換える（取り直さない）', async () => {
        contextSets = { a: [{ id: 'c1', status: 'generating', materials: ['/work/a/x.md'] }] };
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        vi.spyOn(toast, 'success').mockImplementation(() => '');
        receive({ type: 'contextSet', project: 'a', id: 'c1', status: 'ready' });
        expect(cachedContextSets('a')[0].status).toBe('ready');
        expect(calls(get, '/api/projects/a/context-sets')).toBe(1);
        expect(toast.success).toHaveBeenCalledWith('参考資料ができました');
        vi.mocked(toast.success).mockRestore();
    });

    it('contextSet: 知らないセットは、そのプロジェクトの一覧を取り直してキャッシュを新しくする', async () => {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        contextSets = { a: [{ id: 'c2', status: 'generating', materials: ['/work/a/y.md'] }] };
        receive({ type: 'contextSet', project: 'a', id: 'c2', status: 'generating' });
        await vi.waitFor(() => expect(cachedContextSets('a').map((x) => x.id)).toEqual(['c2']));
        expect(calls(get, '/api/projects/a/context-sets')).toBe(2);
        expect(calls(get, '/api/projects/b/context-sets')).toBe(1);
    });
});

describe('セッションの一覧・参考資料セットの一覧', () => {
    it('プロジェクトごとにキャッシュに入れる', async () => {
        sessions = { a: [session('s1', '週次の定例')], b: [session('s1', '情報理論')] };
        contextSets = { b: [{ id: 'c1', status: 'ready', materials: ['/work/b/x.md'] }] };
        mockServer();
        await useAppStore.getState().loadProjects();
        // セッション ID が同じでも、プロジェクトごとに分かれる
        expect(queryClient.getQueryData(sessionsQuery('a').queryKey)?.map((x) => x.title)).toEqual(['週次の定例']);
        expect(queryClient.getQueryData(sessionsQuery('b').queryKey)?.map((x) => x.title)).toEqual(['情報理論']);
        expect(queryClient.getQueryData(contextSetsQuery('a').queryKey)).toEqual([]);
        expect(cachedContextSets('b').map((x) => x.id)).toEqual(['c1']);
        // この 3 つは見ている部品がなくても捨てない。ほかは既定（5 分）のまま
        for (const key of [projectsQuery.queryKey, sessionsQuery('a').queryKey, contextSetsQuery('a').queryKey]) {
            expect(queryClient.getQueryCache().find({ queryKey: key, exact: true })?.gcTime).toBe(Infinity);
        }
        expect(queryClient.getDefaultOptions().queries?.gcTime).toBeUndefined();
        expect(useAppStore.getState().projects.map((p) => p.sessions.map((x) => x.title))).toEqual([
            ['週次の定例'],
            ['情報理論'],
        ]);
    });

    it('参考資料セットの一覧を取れなければ、前の一覧のまま', async () => {
        contextSets = { a: [{ id: 'c1', status: 'ready', materials: ['/work/a/x.md'] }] };
        mockServer();
        await useAppStore.getState().loadProjects();
        contextSetsDown = true;
        contextSets = {};
        await useAppStore.getState().loadProjects();
        expect(cachedContextSets('a').map((x) => x.id)).toEqual(['c1']);
        // プロジェクトの一覧は読めている
        expect(useAppStore.getState().projectsLoaded).toBe(true);
    });

    it('参考資料セットの選択を保存したら、キャッシュのプロジェクトの一覧の選択も新しくする', async () => {
        contextSets = { a: [{ id: 'c1', status: 'ready', materials: ['/work/a/x.md'] }] };
        mockServer();
        await useAppStore.getState().loadProjects();
        useAppStore.setState({ selection: { projectId: 'a', sessionId: null } });
        vi.spyOn(api, 'patch').mockResolvedValue({ ...selection, contextSet: 'c1', pickTerms: false });
        await useAppStore
            .getState()
            .changeContextSelection({ setId: 'c1', useHotwords: true, useContext: true, pickTerms: false });
        const cached = queryClient.getQueryData(projectsQuery.queryKey)?.find((p) => p.id === 'a');
        expect(cached?.selection).toEqual({ setId: 'c1', useHotwords: true, useContext: true, pickTerms: false });
        expect(useAppStore.getState().projects[0].selection?.setId).toBe('c1');
        expect(useAppStore.getState().contextSelections).toEqual({});
        vi.mocked(api.patch).mockRestore();
    });
});

describe('文字起こし・最終の文字起こし', () => {
    const base = '/api/projects/a/sessions/s1';
    const meta = (gid: string) => ({
        generationId: gid,
        model: `model-${gid}`,
        generatedAt: '2026-11-01T12:00:00+09:00',
        diarization: 'off',
        speakers: 0,
    });
    const final = (gid: string, text: string) => ({ lines: [{ time: '00:00:01', text }], meta: meta(gid) });

    beforeEach(() => {
        sessions = {
            a: [
                {
                    ...session('s1', '週次の定例'),
                    files: { recording: true, transcript: true, finalTranscripts: 2, summaries: 0, liveSummary: false },
                },
            ],
        };
        other = {
            [`${base}/transcript`]: { lines: [{ time: '00:00:01', text: 'こんにちわ' }], meta: { corrections: [] } },
            [`${base}/final-transcripts`]: [meta('g1'), meta('g2')],
            [`${base}/final-transcripts/g1`]: final('g1', '古い版'),
            [`${base}/final-transcripts/g2`]: final('g2', '新しい版'),
        };
    });

    const opened = () => useAppStore.getState().projects[0].sessions[0];

    async function open() {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        useAppStore.getState().selectSession('a', 's1');
        await vi.waitFor(() => expect(opened().loaded).toBe(true));
        return get;
    }

    it('開くと、文字起こし・世代の一覧・出す世代をキャッシュに入れる', async () => {
        await open();
        expect(queryClient.getQueryData(queryKeys.transcript('a', 's1'))).toMatchObject({
            lines: [{ text: 'こんにちわ' }],
        });
        expect(queryClient.getQueryData(finalTranscriptsQuery('a', 's1').queryKey)?.map((x) => x.generationId)).toEqual(
            ['g1', 'g2'],
        );
        expect(queryClient.getQueryData(finalTranscriptQuery('a', 's1', 'g2').queryKey)?.lines[0].text).toBe(
            '新しい版',
        );
        expect(opened().finalTranscript?.generationId).toBe('g2');
    });

    it('世代を切り替えて戻っても、取ってある世代は取り直さない', async () => {
        const get = await open();
        await useAppStore.getState().showFinalTranscript('s1', 'g1');
        expect(opened().finalTranscript?.lines[0].text).toBe('古い版');
        await useAppStore.getState().showFinalTranscript('s1', 'g2');
        expect(opened().finalTranscript?.lines[0].text).toBe('新しい版');
        expect(calls(get, `${base}/final-transcripts/g1`)).toBe(1);
        expect(calls(get, `${base}/final-transcripts/g2`)).toBe(1);
    });

    it('corrections: 文字起こしと出している世代を取り直し、ほかの世代も次に出すときに取り直す', async () => {
        const get = await open();
        await useAppStore.getState().showFinalTranscript('s1', 'g1');
        await useAppStore.getState().showFinalTranscript('s1', 'g2');
        other[`${base}/transcript`] = { lines: [{ time: '00:00:01', text: 'こんにちは' }], meta: { corrections: [] } };
        other[`${base}/final-transcripts/g1`] = final('g1', '古い版（置き換え後）');
        other[`${base}/final-transcripts/g2`] = final('g2', '新しい版（置き換え後）');
        receive({ type: 'corrections', session: 's1' });
        await vi.waitFor(() => expect(opened().transcript[0].text).toBe('こんにちは'));
        expect(opened().finalTranscript?.lines[0].text).toBe('新しい版（置き換え後）');
        await useAppStore.getState().showFinalTranscript('s1', 'g1');
        expect(opened().finalTranscript?.lines[0].text).toBe('古い版（置き換え後）');
        expect(calls(get, `${base}/final-transcripts/g1`)).toBe(2);
    });

    it('finalTranscript: 世代の一覧を取り直して、できた世代を出す', async () => {
        await open();
        other[`${base}/final-transcripts`] = [meta('g1'), meta('g2'), meta('g3')];
        other[`${base}/final-transcripts/g3`] = final('g3', '作り直した版');
        receive({ type: 'finalTranscript', session: 's1', generationId: 'g3' });
        await vi.waitFor(() => expect(opened().finalTranscript?.generationId).toBe('g3'));
        expect(queryClient.getQueryData(finalTranscriptsQuery('a', 's1').queryKey)?.map((x) => x.generationId)).toEqual(
            ['g1', 'g2', 'g3'],
        );
        expect(opened().files?.finalTranscripts).toBe(3);
    });

    it('文字起こしを取れなければ、今までどおりエラーを出す', async () => {
        other[`${base}/transcript`] = new ApiError(500, '読めません');
        const error = vi.spyOn(toast, 'error').mockImplementation(() => '');
        await open();
        expect(error).toHaveBeenCalledWith('セッションを読み込めません: 読めません');
        error.mockRestore();
    });
});
