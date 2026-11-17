// セッションの画面の部品から出した計算（#381）
import { describe, expect, it } from 'vitest';

import type { Session, Summary } from '@/api/types';
import { lineAt, nextPlayback } from '@/features/session/playbackLine';
import { canJoin, expired, shareSource } from '@/features/session/sessionContent';
import { defaultSummary, shownSummary } from '@/features/session/summaryPick';
import {
    canRegenerateSummary,
    generatingPlaceholder,
    summaryFailureHint,
    summaryLabel,
} from '@/features/session/summaryView';
import { generationLabel } from '@/features/session/transcriptGenerations';
import { defaultSettings } from '@/features/settings/settings';

const models = defaultSettings.ollama.models;

function summary(id: string, model = 'gemma4:e4b', text: string | undefined = `要約 ${id}`): Summary {
    return { generationId: id, model, generatedAt: `t${id}`, text };
}

function session(patch: Partial<Session> = {}): Session {
    return {
        id: 's1',
        title: '第 3 回',
        startedAt: '2026-11-17 10:00',
        status: 'done',
        loaded: true,
        transcript: [{ time: '00:00:01', text: 'はじめます' }],
        summaries: [],
        ...patch,
    };
}

describe('lineAt', () => {
    it('再生位置以前に始まった最後の行。まだなければ null', () => {
        expect(lineAt([0, 5, 10], 7)).toBe(1);
        expect(lineAt([0, 5, 10], 10)).toBe(2);
        expect(lineAt([3, 5], 1)).toBeNull();
        expect(lineAt([], 1)).toBeNull();
    });
});

describe('nextPlayback', () => {
    it('変わらなければ前のものをそのまま返す', () => {
        const prev = { sessionId: 's1', index: 1, playing: true, seeks: 2 };
        expect(nextPlayback(prev, 's1', 1, true, false)).toBe(prev);
    });

    it('シークした回数は同じセッションのあいだだけ数える', () => {
        const prev = { sessionId: 's1', index: 1, playing: true, seeks: 2 };
        expect(nextPlayback(prev, 's1', 1, true, true)).toEqual({ ...prev, seeks: 3 });
        expect(nextPlayback(prev, 's1', 2, false, false)).toEqual({ ...prev, index: 2, playing: false });
        expect(nextPlayback(prev, 's2', 0, true, true)).toEqual({ sessionId: 's2', index: 0, playing: true, seeks: 1 });
        expect(nextPlayback(null, 's1', null, false, false)).toEqual({
            sessionId: 's1',
            index: null,
            playing: false,
            seeks: 0,
        });
    });
});

describe('expired', () => {
    const files = { recording: false, transcript: false, summaries: 0, liveSummary: false } as Session['files'];

    it('サーバーから取って、ファイルが消えているときだけ期限切れ', () => {
        expect(expired(session({ files }), 'transcript')).toBe(true);
        expect(expired(session({ files }), 'summary')).toBe(true);
        expect(expired(session({ files: { ...files!, summaries: 1 } }), 'summary')).toBe(false);
        expect(expired(session({ files, loaded: false }), 'transcript')).toBe(false);
        expect(expired(session({ files, status: 'recording' }), 'transcript')).toBe(false);
        expect(expired(session(), 'transcript')).toBe(false);
    });
});

describe('shareSource', () => {
    it('文字起こしは渡した行、なければ浄書、なければ録音中のもの', () => {
        const lines = [{ time: '00:00:02', text: '出している行' }];
        expect(shareSource(session(), '要約', lines)).toEqual({ title: '第 3 回', summary: '要約', transcript: lines });
        expect(shareSource(session(), undefined).transcript).toEqual(session().transcript);
    });
});

describe('canJoin', () => {
    it('見ているセッションで、参加できるときだけ', () => {
        expect(canJoin({ sessionId: 's1', state: 'recording', join: { available: true } } as never, 's1')).toBe(true);
        expect(canJoin({ sessionId: 's1', state: 'recording' } as never, 's1')).toBe(false);
        expect(canJoin({ sessionId: 's2', state: 'recording', join: { available: true } } as never, 's1')).toBe(false);
        expect(canJoin(null, 's1')).toBe(false);
    });
});

describe('shownSummary', () => {
    it('既定は今のモデルのいちばん新しいもの、なければいちばん新しいもの', () => {
        const s = session({ summaries: [summary('1'), summary('2', 'qwen3.5:4b')] });
        expect(defaultSummary(s, models)?.generationId).toBe('1');
        expect(defaultSummary(session({ summaries: [summary('3', 'x')] }), models)?.generationId).toBe('3');
    });

    it('手で選んだものは、同じセッションで世代が増えていないあいだだけ使う', () => {
        const s = session({ summaries: [summary('1'), summary('2', 'qwen3.5:4b')] });
        expect(shownSummary(s, models, { sessionId: 's1', count: 2, generationId: '2' })?.generationId).toBe('2');
        expect(shownSummary(s, models, { sessionId: 's1', count: 1, generationId: '2' })?.generationId).toBe('1');
        expect(shownSummary(s, models, { sessionId: 's2', count: 2, generationId: '2' })?.generationId).toBe('1');
    });
});

describe('summaryView', () => {
    it('世代の見出しは、全体概要のモデルが違えば両方出す', () => {
        expect(summaryLabel(summary('1'), models)).toBe('gemma4:e4b で生成・t1');
        expect(summaryLabel({ ...summary('1'), overviewModel: 'qwen3.5:4b' }, models)).toContain('qwen3.5:4b');
    });

    it('作っている途中は、今の要約か途中の要約を出しておく', () => {
        expect(generatingPlaceholder(session(), summary('1'), null)?.live).toBe(false);
        expect(generatingPlaceholder(session({ liveSummary: '途中' }), undefined, null)).toEqual({
            label: 'リアルタイム要約（最終要約が届き次第差し替えます）',
            text: '途中',
            live: true,
        });
        expect(generatingPlaceholder(session(), undefined, { sessionId: 's1', text: '下書き' })?.text).toBe('下書き');
        expect(generatingPlaceholder(session(), undefined, null)).toBeNull();
    });

    it('作り直せるのは、録音を終えて文字起こしが残っていて、ほかを作っていないとき', () => {
        expect(canRegenerateSummary(session(), null)).toBe(true);
        expect(canRegenerateSummary(session({ status: 'recording' }), null)).toBe(false);
        expect(canRegenerateSummary(session({ transcript: [] }), null)).toBe(false);
        expect(canRegenerateSummary(session(), { sessionId: 's2', model: 'm', text: '' })).toBe(false);
    });

    it('作れなかったときの案内を出し分ける', () => {
        expect(summaryFailureHint(session({ transcript: [] }), false, false, 'Ollama')).toBe(
            '文字起こしが残っていないため、再生成できません',
        );
        expect(summaryFailureHint(session(), false, false, 'Ollama')).toBe(
            'ほかの要約を作り終えてから、再生成してください',
        );
        expect(summaryFailureHint(session(), true, false, 'Ollama')).toMatch(/^Ollama には今つながっています/);
        expect(summaryFailureHint(session(), true, true, 'LM Studio')).toBe(
            'LM Studio に接続できません。動いているか確かめてから再生成してください',
        );
    });
});

describe('generationLabel', () => {
    it('話者を分けた世代は、表示する設定なら話者の数を入れる', () => {
        const g = {
            generationId: 'g',
            model: 'large-v3',
            generatedAt: 't',
            diarization: 'done' as const,
            speakers: 3,
        };
        expect(generationLabel(g, true)).toBe('large-v3・話者 3 人・t');
        expect(generationLabel(g, false)).toBe('large-v3・t');
        expect(generationLabel({ ...g, diarization: 'off' }, true)).toBe('large-v3・t');
    });
});
