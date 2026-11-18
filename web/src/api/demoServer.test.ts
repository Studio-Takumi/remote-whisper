import { describe, expect, it } from 'vitest';

import { DemoServer } from '@/api/demoServer';
import type { DemoIndex, DemoSession } from '@/api/demoTypes';
import type { SettingsOptions } from '@/api/protocol';
import { toSummary } from '@/api/summaries';
import { type Settings, defaultSettings, llmModels } from '@/features/settings/settings';

// 小さな偽のデータ（プロジェクト 1 つ、セッション 1 つ、要約 2 版）
const SID = '20260101-100000';
const BASE = `/api/projects/p1/sessions/${SID}`;

const index: DemoIndex = {
    projects: [{ id: 'p1', uuid: 'u1', name: 'Channel', path: 'C:\\bench\\Channel' }],
    sessions: { p1: [{ id: SID, title: '動画', files: { recording: false, transcript: true } }] },
    contextSets: { p1: [] },
    settings: { ollama: { models: { overview: 'gemma4:e4b', detail: 'gemma4:e4b' } } },
};

const summary = (generationId: string, model: string) => ({
    generationId,
    model,
    overviewModel: model,
    think: true,
    generatedAt: '2026-01-01T12:00:00+09:00',
    title: model,
});

const session: DemoSession = {
    transcript: { meta: { id: SID, corrections: [] }, lines: [] },
    finalTranscripts: [{ id: SID, generationId: '20260101-110000', model: 'large-v3-turbo' }],
    finalTranscriptLines: { '20260101-110000': [{ time: '00:00:01', text: 'こんにちは' }] },
    // gemma のほうが古くても、今のモデルの組（gemma）のものを出す
    summaries: [summary('20260101-120000', 'gemma4:e4b'), summary('20260101-130000', 'qwen3.5:4b')],
    summaryTexts: { '20260101-120000': 'gemma の要約', '20260101-130000': 'qwen の要約' },
};

function server() {
    const loaded: string[] = [];
    const demo = new DemoServer(index, (pid, sid) => {
        loaded.push(`${pid}/${sid}`);
        return pid === 'p1' && sid === SID ? Promise.resolve(session) : null;
    });
    return { demo, loaded };
}

describe('DemoServer', () => {
    it('一覧は最初のデータから答え、セッションの中身はそのとき読む', async () => {
        const { demo, loaded } = server();
        expect((await demo.respond('GET', '/api/projects')).body).toEqual(index.projects);
        expect((await demo.respond('GET', '/api/projects/p1/sessions')).body).toEqual(index.sessions.p1);
        expect((await demo.respond('GET', '/api/projects/p1/context-sets')).body).toEqual([]);
        expect(loaded).toEqual([]);
        expect((await demo.respond('GET', `${BASE}/transcript`)).body).toEqual(session.transcript);
        expect(loaded).toEqual([`p1/${SID}`]);
    });

    it('浄書の世代と本文を返す', async () => {
        const { demo } = server();
        expect((await demo.respond('GET', `${BASE}/final-transcripts`)).body).toEqual(session.finalTranscripts);
        expect((await demo.respond('GET', `${BASE}/final-transcripts/latest`)).body).toEqual({
            meta: session.finalTranscripts[0],
            lines: [{ time: '00:00:01', text: 'こんにちは' }],
        });
    });

    it('要約の版を返し、latest は今のモデルの組のうちいちばん新しいもの', async () => {
        const { demo } = server();
        const infos = (await demo.respond('GET', `${BASE}/summaries`)).body as DemoSession['summaries'];
        expect(infos.map((i) => toSummary(i, undefined).model)).toEqual(['gemma4:e4b', 'qwen3.5:4b']);
        expect((await demo.respond('GET', `${BASE}/summaries/20260101-130000`)).body).toMatchObject({
            kind: 'final',
            model: 'qwen3.5:4b',
            text: 'qwen の要約',
        });
        expect((await demo.respond('GET', `${BASE}/summaries/latest`)).body).toMatchObject({ text: 'gemma の要約' });
    });

    it('ないものはサーバーと同じステータスで、変える操作は受けない', async () => {
        const { demo } = server();
        expect((await demo.respond('GET', '/api/projects/nope/sessions')).status).toBe(404);
        expect((await demo.respond('GET', '/api/projects/p1/sessions/20990101-000000')).status).toBe(404);
        expect((await demo.respond('GET', `${BASE}/summaries/20990101-000000`)).status).toBe(404);
        expect((await demo.respond('GET', '/api/setup')).status).toBe(404);
        expect((await demo.respond('POST', `${BASE}/summaries`)).status).toBe(403);
        expect((await demo.respond('PATCH', '/api/settings')).status).toBe(403);
    });

    it('設定は同梱した値で、足りない項目と空の relayUrl は既定値になる', async () => {
        const raw = { ...index.settings, cloud: { relayUrl: '' }, display: { showSpeakers: true } };
        const demo = new DemoServer({ ...index, settings: raw }, () => null);
        const settings = (await demo.respond('GET', '/api/settings')).body as Settings;
        expect(settings.ollama.models.detail).toBe('gemma4:e4b');
        expect(settings.ollama.host).toBe(defaultSettings.ollama.host);
        expect(settings.display).toEqual({ ...defaultSettings.display, showSpeakers: true });
        expect(settings.cloud).toEqual(defaultSettings.cloud);
    });

    it('選べるモデルは 5 つ', async () => {
        const { demo } = server();
        const options = (await demo.respond('GET', '/api/settings/options')).body as SettingsOptions;
        expect(options.llm.models.map((m) => m.name)).toEqual([
            'qwen3.5:4b',
            'qwen3.5:2b',
            'qwen3.5:0.8b',
            'gemma4:e4b',
            'gemma4:e2b',
        ]);
    });

    it('要約の既定の版は、設定の全体概要と要約詳細のモデルの組で選ぶ', async () => {
        const qwen = { ollama: { models: { overview: 'qwen3.5:4b', detail: 'qwen3.5:4b' } } };
        const demo = new DemoServer({ ...index, settings: qwen }, () => Promise.resolve(session));
        expect((await demo.respond('GET', `${BASE}/summaries/latest`)).body).toMatchObject({ text: 'qwen の要約' });
        const settings = (await demo.respond('GET', '/api/settings')).body as Settings;
        expect(llmModels(settings)).toMatchObject({ overview: 'qwen3.5:4b', detail: 'qwen3.5:4b' });
    });

    it('見え方を変えるもの（リプレイ #416）があれば、一覧の行と中身をそれで答える', async () => {
        const demo = new DemoServer(index, () => Promise.resolve(session), {
            row: (_pid, row) => ({ ...row, status: 'recording' }),
            session: (_pid, _sid, data) => ({ ...data, summaries: [], summaryTexts: {}, liveSummary: '途中' }),
        });
        expect((await demo.respond('GET', '/api/projects/p1/sessions')).body).toMatchObject([{ status: 'recording' }]);
        expect((await demo.respond('GET', BASE)).body).toMatchObject({ status: 'recording' });
        expect((await demo.respond('GET', `${BASE}/summaries`)).body).toEqual([]);
        expect((await demo.respond('GET', `${BASE}/summaries/latest`)).body).toEqual({ kind: 'live', text: '途中' });
    });
});
