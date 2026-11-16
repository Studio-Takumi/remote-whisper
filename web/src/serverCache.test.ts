import 'fake-indexeddb/auto';
import { toast } from 'sonner';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type ProjectJson, type SessionJson, api } from '@/api';
import { connection } from '@/connection';
import {
    finalTranscriptQuery,
    liveSummaryQuery,
    projectsQuery,
    sessionsQuery,
    summariesQuery,
    summaryQuery,
    transcriptQuery,
} from '@/data';
import type { ServerMessage } from '@/protocol';
import { queryClient } from '@/query';
import { defaultSettings } from '@/settings';
import { useAppStore } from '@/store';

// #330 の 4 段目: 要約のキャッシュ・WebSocket の通知をキャッシュに入れる・操作（mutation）の楽観的更新と巻き戻し

const selection = { contextSet: null, useHotwords: true, useContext: true };
const project = (id: string): ProjectJson => ({ id, name: id, path: `/work/${id}`, selection });
const files = { recording: true, transcript: true, finalTranscripts: 0, summaries: 0, liveSummary: false };
const session = (id: string, title: string, more: Partial<SessionJson['files']> = {}): SessionJson => ({
    id,
    title,
    status: 'done',
    startedAt: '2026-11-01T10:00:00+09:00',
    endedAt: '2026-11-01T11:00:00+09:00',
    contextSet: null,
    files: { ...files, ...more },
});
const base = '/api/projects/a/sessions/s1';
const finalMeta = (gid: string) => ({
    generationId: gid,
    model: `model-${gid}`,
    generatedAt: '2026-11-01T12:00:00+09:00',
    diarization: 'off',
    speakers: 0,
});

// サーバーの返事（パスごと）。Error を入れたらそれを投げる。関数を入れたら呼んだ結果を返す
let responses: Record<string, unknown> = {};

function mockServer() {
    return vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
        if (!(path in responses)) {
            if (path.endsWith('/context-sets')) {
                return [];
            }
            throw new Error(`unexpected GET ${path}`);
        }
        const r = responses[path];
        if (r instanceof Error) {
            throw r;
        }
        return typeof r === 'function' ? r() : structuredClone(r);
    });
}

const calls = (get: ReturnType<typeof mockServer>, path: string) => get.mock.calls.filter(([p]) => p === path).length;

let receive: (m: ServerMessage) => void = () => {};

beforeAll(() => {
    vi.spyOn(connection, 'start').mockImplementation(() => {});
    vi.spyOn(connection, 'send').mockImplementation(() => {});
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
        settings: { ...defaultSettings, projectOrder: [] },
        settingsLoaded: true,
        watching: null,
    });
    responses = {
        '/api/projects': [project('a'), project('b')],
        '/api/projects/a/sessions': [session('s1', '週次の定例')],
        '/api/projects/b/sessions': [],
        [`${base}/transcript`]: {
            lines: [
                { time: '00:00:01', text: 'りりーす計画' },
                { time: '00:00:05', text: '始めます' },
            ],
            meta: { pickedTerms: ['リリース'], manualTerms: [], corrections: [] },
        },
    };
    vi.spyOn(toast, 'error').mockImplementation(() => '');
    vi.spyOn(toast, 'success').mockImplementation(() => '');
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(connection, 'send').mockImplementation(() => {});
});

const opened = () => useAppStore.getState().projects.find((p) => p.id === 'a')!.sessions[0];

async function open() {
    const get = mockServer();
    await useAppStore.getState().loadProjects();
    useAppStore.getState().selectSession('a', 's1');
    await vi.waitFor(() => expect(opened().loaded).toBe(true));
    return get;
}

describe('要約', () => {
    it('最終の要約の一覧と版をキャッシュに入れ、版は取り直さない', async () => {
        responses['/api/projects/a/sessions'] = [session('s1', '週次の定例', { summaries: 1 })];
        responses[`${base}/summaries`] = [
            { generationId: 'm1', model: 'gemma', think: false, generatedAt: '2026-11-01T12:00:00+09:00', title: 't' },
        ];
        responses[`${base}/summaries/m1`] = { kind: 'final', text: '## 決まったこと' };
        const get = await open();
        expect(opened().summaries.map((x) => x.text)).toEqual(['## 決まったこと']);
        expect(queryClient.getQueryData(summariesQuery('a', 's1').queryKey)?.map((x) => x.generationId)).toEqual([
            'm1',
        ]);
        expect(queryClient.getQueryData(summaryQuery('a', 's1', 'm1').queryKey)?.text).toBe('## 決まったこと');
        // 読み直しても、版は取り直さない（一覧は取り直す）
        useAppStore.setState((s) => ({
            projects: s.projects.map((p) => ({ ...p, sessions: p.sessions.map((x) => ({ ...x, loaded: false })) })),
        }));
        useAppStore.getState().selectSession('a', 's1');
        await vi.waitFor(() => expect(opened().loaded).toBe(true));
        expect(calls(get, `${base}/summaries`)).toBe(2);
        expect(calls(get, `${base}/summaries/m1`)).toBe(1);
    });

    it('最終の要約がなければ、途中の要約をキャッシュに入れる', async () => {
        responses['/api/projects/a/sessions'] = [session('s1', '週次の定例', { liveSummary: true })];
        responses[`${base}/summaries/latest`] = { kind: 'live', text: '途中の要約' };
        await open();
        expect(opened().liveSummary).toBe('途中の要約');
        expect(queryClient.getQueryData(liveSummaryQuery('a', 's1').queryKey)?.text).toBe('途中の要約');
    });
});

describe('WebSocket の通知をキャッシュに入れる', () => {
    it('見ている録音の watching・final・terms・途中の要約が、文字起こしとセッションの一覧のキャッシュに入る', async () => {
        await open();
        receive({
            type: 'watching',
            session: 's1',
            state: 'recording',
            transcript: [{ time: '00:00:01', text: '最初の行' }],
            liveSummary: null,
            title: '録音中のタイトル',
        } as ServerMessage);
        await vi.waitFor(() =>
            expect(queryClient.getQueryData(transcriptQuery('a', 's1').queryKey)?.lines.map((x) => x.text)).toEqual([
                '最初の行',
            ]),
        );
        expect(queryClient.getQueryData(sessionsQuery('a').queryKey)?.[0].title).toBe('録音中のタイトル');
        receive({ type: 'final', session: 's1', segment: 1, start: 3, end: 5, text: '次の行' });
        receive({ type: 'terms', session: 's1', terms: ['定例'], rejected: [], manual: ['手で足した語'] });
        receive({ type: 'summary.delta', session: 's1', kind: 'live', text: '途中', replace: true });
        receive({ type: 'summary.done', session: 's1', kind: 'live' });
        await vi.waitFor(() => {
            const t = queryClient.getQueryData(transcriptQuery('a', 's1').queryKey);
            expect(t?.lines.map((x) => x.text)).toEqual(['最初の行', '次の行']);
            expect(t?.meta?.pickedTerms).toEqual(['定例']);
            expect(t?.meta?.manualTerms).toEqual(['手で足した語']);
        });
        expect(queryClient.getQueryData(liveSummaryQuery('a', 's1').queryKey)?.text).toBe('途中');
    });

    it('置き換えの前に取り始めた版が、置き換えのあとに届いても、キャッシュに残らない', async () => {
        responses['/api/projects/a/sessions'] = [session('s1', '週次の定例', { finalTranscripts: 1 })];
        responses[`${base}/final-transcripts`] = [finalMeta('g1'), finalMeta('g2')];
        responses[`${base}/final-transcripts/g1`] = {
            lines: [{ time: '00:00:01', text: 'g1' }],
            meta: finalMeta('g1'),
        };
        responses[`${base}/final-transcripts/g2`] = {
            lines: [{ time: '00:00:01', text: '古い' }],
            meta: finalMeta('g2'),
        };
        const get = await open();
        // g2 を取り始める（まだ返さない）
        let release: () => void = () => {};
        const old = { lines: [{ time: '00:00:01', text: '古い' }], meta: finalMeta('g2') };
        queryClient.removeQueries({ queryKey: finalTranscriptQuery('a', 's1', 'g2').queryKey });
        responses[`${base}/final-transcripts/g2`] = () => new Promise((r) => (release = () => r(old)));
        const pending = queryClient.fetchQuery(finalTranscriptQuery('a', 's1', 'g2'));
        // 置き換えが届き、サーバーは置き換えたものを返すようになる
        responses[`${base}/final-transcripts/g2`] = {
            lines: [{ time: '00:00:01', text: '新しい' }],
            meta: finalMeta('g2'),
        };
        receive({ type: 'corrections', session: 's1' });
        release();
        // 古いものは届いたが、キャッシュには残らない（消えるか、取り直した新しいものになる）
        expect((await pending).lines[0].text).toBe('古い');
        await vi.waitFor(() =>
            expect(queryClient.getQueryData(finalTranscriptQuery('a', 's1', 'g2').queryKey)?.lines[0].text).not.toBe(
                '古い',
            ),
        );
        await useAppStore.getState().showFinalTranscript('s1', 'g2');
        expect(opened().finalTranscript?.lines[0].text).toBe('新しい');
        expect(calls(get, `${base}/final-transcripts/g2`)).toBeGreaterThanOrEqual(3);
    });
});

describe('操作の楽観的更新と巻き戻し', () => {
    it('プロジェクトの並べ替え: 先に並べ替え、保存できなければ前の並びに戻す（取り直さない）', async () => {
        const get = mockServer();
        await useAppStore.getState().loadProjects();
        let reject: (e: Error) => void = () => {};
        vi.spyOn(api, 'patch').mockImplementation(() => new Promise((_r, j) => (reject = j)));
        const done = useAppStore.getState().reorderProjects(['b', 'a']);
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['b', 'a']);
        expect(queryClient.getQueryData(projectsQuery.queryKey)?.map((p) => p.id)).toEqual(['b', 'a']);
        await vi.waitFor(() => expect(api.patch).toHaveBeenCalled());
        reject(new ApiError(0, 'ホストにつながりません'));
        await done;
        expect(useAppStore.getState().projects.map((p) => p.id)).toEqual(['a', 'b']);
        expect(queryClient.getQueryData(projectsQuery.queryKey)?.map((p) => p.id)).toEqual(['a', 'b']);
        expect(useAppStore.getState().settings.projectOrder).toEqual([]);
        expect(toast.error).toHaveBeenCalledWith('プロジェクトの並びを保存できません: ホストにつながりません');
        expect(calls(get, '/api/projects')).toBe(1);
    });

    it('セッションの移動: 先に移し、移せなければ元のプロジェクトに戻す', async () => {
        await open();
        let reject: (e: Error) => void = () => {};
        vi.spyOn(api, 'post').mockImplementation(() => new Promise((_r, j) => (reject = j)));
        const done = useAppStore.getState().moveSession('a', 's1', 'b');
        const ids = (pid: string) =>
            useAppStore
                .getState()
                .projects.find((p) => p.id === pid)!
                .sessions.map((x) => x.id);
        expect(ids('b')).toEqual(['s1']);
        expect(queryClient.getQueryData(sessionsQuery('b').queryKey)?.map((x) => x.id)).toEqual(['s1']);
        expect(useAppStore.getState().selection).toEqual({ projectId: 'b', sessionId: 's1' });
        await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
        reject(new ApiError(409, '録音中です'));
        await done;
        expect(ids('a')).toEqual(['s1']);
        expect(ids('b')).toEqual([]);
        expect(queryClient.getQueryData(sessionsQuery('a').queryKey)?.map((x) => x.id)).toEqual(['s1']);
        expect(useAppStore.getState().selection).toEqual({ projectId: 'a', sessionId: 's1' });
        expect(toast.error).toHaveBeenCalledWith('「週次の定例」を移せません: 録音中です');
        // 中身は読み込んだまま
        expect(opened().loaded).toBe(true);
    });

    it('用語を消す: 先に消し、消せなければ戻す（キャッシュも）', async () => {
        await open();
        vi.spyOn(api, 'delete').mockRejectedValue(new ApiError(0, 'ホストにつながりません'));
        await useAppStore.getState().rejectTerm('s1', 'リリース');
        expect(opened().pickedTerms).toEqual(['リリース']);
        expect(queryClient.getQueryData(transcriptQuery('a', 's1').queryKey)?.meta?.pickedTerms).toEqual(['リリース']);
        expect(toast.error).toHaveBeenCalledWith('用語を消せません: ホストにつながりません');
    });

    it('置き換え: 先に置き換え、できなければ戻す。待っている間に届いた行は残す', async () => {
        await open();
        let reject: (e: Error) => void = () => {};
        vi.spyOn(api, 'post').mockImplementation(() => new Promise((_r, j) => (reject = j)));
        const done = useAppStore.getState().addCorrection('s1', { from: 'りりーす', to: 'リリース', line: null });
        expect(opened().transcript[0].text).toBe('リリース計画');
        // 待っている間に行が届いた（録音中）
        useAppStore.setState((s) => ({
            projects: s.projects.map((p) => ({
                ...p,
                sessions: p.sessions.map((x) => ({
                    ...x,
                    transcript: [...x.transcript, { time: '00:00:09', text: '届いた行' }],
                })),
            })),
        }));
        await vi.waitFor(() => expect(api.post).toHaveBeenCalled());
        reject(new ApiError(400, '置き換えられない語です'));
        expect(await done).toBe(false);
        expect(opened().transcript.map((x) => x.text)).toEqual(['りりーす計画', '始めます', '届いた行']);
        expect(opened().corrections).toEqual([]);
        expect(toast.error).toHaveBeenCalledWith('置き換えられません: 置き換えられない語です');
    });

    it('置き換えを外す: 先に一覧から外し、外せなければ戻す', async () => {
        const correction = { from: 'りりーす', to: 'リリース', line: null };
        responses[`${base}/transcript`] = {
            lines: [{ time: '00:00:01', text: 'リリース計画' }],
            meta: { pickedTerms: [], manualTerms: ['リリース'], corrections: [correction] },
        };
        await open();
        let reject: (e: Error) => void = () => {};
        vi.spyOn(api, 'delete').mockImplementation(() => new Promise((_r, j) => (reject = j)));
        const done = useAppStore.getState().removeCorrection('s1', correction);
        expect(opened().corrections).toEqual([]);
        await vi.waitFor(() => expect(api.delete).toHaveBeenCalled());
        reject(new ApiError(0, 'ホストにつながりません'));
        await done;
        expect(opened().corrections).toEqual([correction]);
        expect(queryClient.getQueryData(transcriptQuery('a', 's1').queryKey)?.meta?.corrections).toEqual([correction]);
    });
});
