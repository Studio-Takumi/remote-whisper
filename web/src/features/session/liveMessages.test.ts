import { describe, expect, it } from 'vitest';

import type { Session } from '@/api/types';
import { type LiveChange, type LiveState, applyLiveMessage, isLiveMessage } from '@/features/session/liveMessages';

const S = 'S1';
const OTHER = 'S2';

function state(over: Partial<LiveState> = {}): LiveState {
    return { partials: [], liveDraft: null, ...over };
}

function base(id: string): Session {
    return {
        id,
        title: id,
        startedAt: '2026-11-17 10:00',
        status: 'recording',
        transcript: [{ time: '00:00:00', text: '前の行' }],
        summaries: [],
        manualTerms: ['手入力'],
    };
}

// メッセージのセッション（S）に、返ってきた書き換えを当てたもの。#361 から書き換えは関数で返り、
// どこ（手元のセッションかキャッシュか）に当てるかは呼ぶ側が決める。ほかのセッションは変わらない
function sessionOf(s: LiveChange | null, id = S) {
    return id === S && s?.session ? s.session(base(id)) : base(id);
}

describe('isLiveMessage', () => {
    it('partial・final・terms と、途中の要約（kind: live）だけ', () => {
        expect(isLiveMessage({ type: 'partial', session: S, segment: 0, committed: '', tentative: '' })).toBe(true);
        expect(isLiveMessage({ type: 'terms', session: S, terms: [], rejected: [] })).toBe(true);
        expect(isLiveMessage({ type: 'summary.delta', session: S, kind: 'live', text: '' })).toBe(true);
        expect(isLiveMessage({ type: 'summary.done', session: S, kind: 'final' })).toBe(false);
        expect(isLiveMessage({ type: 'ack', session: S, seq: 0 })).toBe(false);
    });
});

describe('applyLiveMessage', () => {
    it('partial は同じセッション・音源のものを置き換える', () => {
        const before = state({ partials: [{ sessionId: S, segment: 0, committed: 'こ', tentative: '' }] });
        const next = applyLiveMessage(before, {
            type: 'partial',
            session: S,
            segment: 1,
            committed: 'こんに',
            tentative: 'ちは',
        });
        expect(next).toEqual({ partials: [{ sessionId: S, segment: 1, committed: 'こんに', tentative: 'ちは' }] });
    });

    it('partial の source は来たときだけ持つ', () => {
        const next = applyLiveMessage(state(), {
            type: 'partial',
            session: S,
            segment: 0,
            committed: '',
            tentative: 'あ',
            source: 2,
        });
        expect(next?.partials).toEqual([{ sessionId: S, segment: 0, committed: '', tentative: 'あ', source: 2 }]);
    });

    it('final は行を足し、同じ segment の partial を消す', () => {
        const before = state({ partials: [{ sessionId: S, segment: 3, committed: '続', tentative: 'き' }] });
        const next = applyLiveMessage(before, {
            type: 'final',
            session: S,
            segment: 3,
            start: 65,
            end: 66,
            text: '続き',
        });
        expect(next?.partials).toEqual([]);
        expect(sessionOf(next)?.transcript).toEqual([
            { time: '00:00:00', text: '前の行' },
            { time: '00:01:05', text: '続き' },
        ]);
        expect(sessionOf(next, OTHER)?.transcript).toHaveLength(1);
    });

    it('text が空の final は行にせず、partial を消すだけ', () => {
        const before = state({ partials: [{ sessionId: S, segment: 0, committed: '', tentative: 'えー' }] });
        const next = applyLiveMessage(before, { type: 'final', session: S, segment: 0, start: 0, end: 1, text: '' });
        expect(next?.session).toBeUndefined();
        expect(next?.partials).toEqual([]);
    });

    it('terms は拾った語を置き換え、manual が来なければ手入力の語を残す', () => {
        const picked = applyLiveMessage(state(), { type: 'terms', session: S, terms: ['Whisper'], rejected: [] });
        expect(sessionOf(picked)).toMatchObject({ pickedTerms: ['Whisper'], manualTerms: ['手入力'] });
        const manual = applyLiveMessage(state(), {
            type: 'terms',
            session: S,
            terms: [],
            rejected: [],
            manual: ['Ollama'],
        });
        expect(sessionOf(manual)?.manualTerms).toEqual(['Ollama']);
    });

    it('途中の要約は回の始まり（replace）から積み、始まりのない続きは捨てる', () => {
        expect(applyLiveMessage(state(), { type: 'summary.delta', session: S, kind: 'live', text: '断片' })).toBeNull();
        const started = applyLiveMessage(state(), {
            type: 'summary.delta',
            session: S,
            kind: 'live',
            text: 'まとめ',
            replace: true,
        });
        expect(started).toEqual({ liveDraft: { sessionId: S, text: 'まとめ' } });
        const next = applyLiveMessage(state({ liveDraft: { sessionId: S, text: 'まとめ' } }), {
            type: 'summary.delta',
            session: S,
            kind: 'live',
            text: 'の続き',
        });
        expect(next).toEqual({ liveDraft: { sessionId: S, text: 'まとめの続き' } });
    });

    it('replace は下書きを置き換え、ほかのセッションの下書きに続きを足さない', () => {
        const draft = { sessionId: OTHER, text: 'ほか' };
        expect(
            applyLiveMessage(state({ liveDraft: draft }), {
                type: 'summary.delta',
                session: S,
                kind: 'live',
                text: '続',
            }),
        ).toBeNull();
        const replaced = applyLiveMessage(state({ liveDraft: { sessionId: S, text: '古い' } }), {
            type: 'summary.delta',
            session: S,
            kind: 'live',
            text: '新しい',
            replace: true,
        });
        expect(replaced).toEqual({ liveDraft: { sessionId: S, text: '新しい' } });
    });

    it('done は下書きをセッションに入れて消す', () => {
        const next = applyLiveMessage(state({ liveDraft: { sessionId: S, text: 'まとめ' } }), {
            type: 'summary.done',
            session: S,
            kind: 'live',
        });
        expect(next?.liveDraft).toBeNull();
        expect(sessionOf(next)?.liveSummary).toBe('まとめ');
    });

    it('done はほかのセッションの下書きを使わず、そのまま残す', () => {
        const before = state({ liveDraft: { sessionId: OTHER, text: 'ほか' } });
        const next = applyLiveMessage(before, { type: 'summary.done', session: S, kind: 'live' });
        expect(next).toEqual({ liveDraft: before.liveDraft });
    });

    it('最終の要約（kind: final）は扱わない', () => {
        expect(
            applyLiveMessage(state(), { type: 'summary.delta', session: S, kind: 'final', text: 'x', replace: true }),
        ).toBeNull();
        expect(applyLiveMessage(state(), { type: 'summary.done', session: S, kind: 'final' })).toBeNull();
    });
});
