import { describe, expect, it } from 'vitest';

import { DemoServer } from '@/api/demoServer';
import type { DemoIndex, DemoSession } from '@/api/demoTypes';
import { toSummary } from '@/api/summaries';

// 小さな偽のデータ（プロジェクト 1 つ、セッション 1 つ、要約 2 版）
const SID = '20260101-100000';
const BASE = `/api/projects/p1/sessions/${SID}`;

const index: DemoIndex = {
    projects: [{ id: 'p1', uuid: 'u1', name: 'Channel', path: 'C:\\bench\\Channel' }],
    sessions: { p1: [{ id: SID, title: '動画', files: { recording: false, transcript: true } }] },
    contextSets: { p1: [] },
    models: { overview: 'gemma4:e4b', detail: 'gemma4:e4b' },
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
        expect((await demo.respond('GET', '/api/settings')).status).toBe(404);
        expect((await demo.respond('POST', `${BASE}/summaries`)).status).toBe(403);
    });
});
