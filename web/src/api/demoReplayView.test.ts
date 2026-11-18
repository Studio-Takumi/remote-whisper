import { describe, expect, it } from 'vitest';

import { ReplayView } from '@/api/demoReplayView';
import type { DemoReplay, DemoSession } from '@/api/demoTypes';

// 小さな偽の記録（録音中に final 2 つ・途中の要約 1 回・仮のタイトル、10 秒で録音を終え、浄書・最終のタイトル）
const PID = 'r1';
const SID = '20260101-100000';
const target = { projectId: PID, sessionId: SID };

const record: DemoReplay = {
    stopAt: 10,
    messages: [
        { t: 1, msg: { type: 'final', segment: 0, start: 0.5, end: 1, text: '一行目', session: SID } },
        { t: 2, msg: { type: 'final', segment: 1, start: 1, end: 2, text: '', session: SID } },
        { t: 3, msg: { type: 'summary.delta', kind: 'live', text: '', replace: true, session: SID } },
        { t: 3.5, msg: { type: 'summary.delta', kind: 'live', text: '途中の', session: SID } },
        { t: 4, msg: { type: 'summary.delta', kind: 'live', text: '要約', session: SID } },
        { t: 4.5, msg: { type: 'summary.done', kind: 'live', session: SID } },
        { t: 5, msg: { type: 'title', title: '仮', provisional: true, session: SID } },
        { t: 6, msg: { type: 'final', segment: 2, start: 62, end: 63, text: '二行目', session: SID } },
        { t: 12, msg: { type: 'finalTranscript', generationId: '20260101-100100', session: SID } },
        { t: 15, msg: { type: 'title', title: '最終', provisional: false, session: SID } },
    ],
};

const row = {
    id: SID,
    title: '最終',
    status: 'done',
    endedAt: '2026-01-01T10:00:10+09:00',
    durationSec: 10,
    files: { recording: false, transcript: true, finalTranscripts: 1, summaries: 2, liveSummary: false },
};

const data: DemoSession = {
    transcript: {
        meta: { id: SID },
        lines: [
            { time: '00:00:00', text: '一行目' },
            { time: '00:01:02', text: '二行目' },
            { time: '00:01:05', text: '最後の行' },
        ],
    },
    finalTranscripts: [{ id: SID, generationId: '20260101-100100' }],
    finalTranscriptLines: { '20260101-100100': [{ time: '00:00:00', text: '浄書' }] },
    summaries: [
        {
            generationId: '20260101-100200',
            model: 'gemma4:e4b',
            overviewModel: 'gemma4:e4b',
            think: true,
            generatedAt: '2026-01-01T10:02:00+09:00',
            title: '最終',
        },
    ],
    summaryTexts: { '20260101-100200': '最終の要約' },
};

function view(at: number, withRecord = true) {
    const v = new ReplayView(target);
    if (withRecord) {
        v.setRecord(record);
    }
    v.seek(at);
    return { row: v.row(PID, row), session: v.session(PID, SID, data), v };
}

describe('ReplayView', () => {
    it('再生していないときは、録音を始めたところの形（録音中・中身は空）', () => {
        const { row: r, session } = view(0, false);
        expect(r).toMatchObject({ status: 'recording', title: null, endedAt: null, durationSec: null });
        expect(r.files).toEqual({
            recording: false,
            transcript: true,
            finalTranscripts: 0,
            summaries: 0,
            liveSummary: false,
        });
        expect(session.transcript?.lines).toEqual([]);
        expect(session.summaries).toEqual([]);
        expect(session.liveSummary).toBeUndefined();
    });

    it('録音中は、そこまでに届いた final の行・できた途中の要約・仮のタイトル', () => {
        const { row: r, session } = view(5);
        expect(r).toMatchObject({ status: 'recording', title: '仮' });
        expect((r.files as { liveSummary: boolean }).liveSummary).toBe(true);
        // 空の final は行にならない
        expect(session.transcript?.lines).toEqual([{ time: '00:00:00', text: '一行目' }]);
        expect(session.liveSummary).toBe('途中の要約');
        expect(session.finalTranscripts).toEqual([]);
        expect(view(6).session.transcript?.lines.at(-1)).toEqual({ time: '00:01:02', text: '二行目' });
    });

    it('録音を終えたら終えた行で、文字起こしはファイルのまま。浄書は届いてから、最終の要約はまだ', () => {
        const stopped = view(10);
        expect(stopped.row).toMatchObject({ status: 'done', title: '仮', endedAt: row.endedAt, durationSec: 10 });
        expect(stopped.session.transcript?.lines).toEqual(data.transcript?.lines);
        expect(stopped.session.finalTranscripts).toEqual([]);
        expect((stopped.row.files as { finalTranscripts: number }).finalTranscripts).toBe(0);
        const transcribed = view(12);
        expect(transcribed.session.finalTranscripts).toEqual(data.finalTranscripts);
        expect((transcribed.row.files as { finalTranscripts: number }).finalTranscripts).toBe(1);
        expect(transcribed.session.summaries).toEqual([]);
        expect(transcribed.session.liveSummary).toBe('途中の要約');
    });

    it('最終のタイトルが届いたら（最後まで再生したら）、同梱したまま', () => {
        expect(view(15).row).toBe(row);
        expect(view(15).session).toBe(data);
        expect(view(Infinity).row).toBe(row);
    });

    it('リプレイのセッションでなければ、いつも同梱したまま', () => {
        const v = new ReplayView(target);
        v.setRecord(record);
        v.seek(5);
        const other = { ...row, id: '20260101-110000' };
        expect(v.row(PID, other)).toBe(other);
        expect(v.row('home', row)).toBe(row);
        expect(v.session('home', SID, data)).toBe(data);
    });

    it('始まりを受けていない途中の要約の続きは捨てる（画面と同じ）', () => {
        const v = new ReplayView(target);
        v.setRecord({
            stopAt: 10,
            messages: [
                { t: 1, msg: { type: 'summary.delta', kind: 'live', text: '断片', session: SID } },
                { t: 2, msg: { type: 'summary.done', kind: 'live', session: SID } },
            ],
        });
        v.seek(5);
        expect(v.session(PID, SID, data).liveSummary).toBeUndefined();
    });
});
