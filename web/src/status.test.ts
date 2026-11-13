import { describe, expect, it } from 'vitest';

import { jobProgress } from '@/status';

// GPU のジョブ一覧の、実行中のジョブの進み具合（#340）
describe('jobProgress', () => {
    it('件数のある段階は「3/6」とバーの割合を出す', () => {
        expect(jobProgress('finalSummary', { step: 'parts', done: 3, total: 6 })).toEqual({
            text: '要約詳細 3/6',
            ratio: 0.5,
        });
    });

    it('件数のない段階は名前だけで、バーは出さない', () => {
        expect(jobProgress('finalSummary', { step: 'overview' })).toEqual({ text: '全体概要', ratio: null });
        expect(jobProgress('finalSummary', { step: 'title' })).toEqual({ text: 'タイトル', ratio: null });
    });

    it('浄書は段階の数と、段階の中の % を出す', () => {
        expect(jobProgress('finalTranscript', { step: 'align', done: 2, total: 4, percent: 37.5 })).toEqual({
            text: '位置合わせ 2/4 37%',
            ratio: (2 + 0.375) / 4,
        });
        expect(jobProgress('finalTranscript', { step: 'load', done: 0, total: 3 })).toEqual({
            text: 'モデルの読み込み 0/3',
            ratio: 0,
        });
    });

    it('進み具合がない（古いサーバー・ほかのジョブ）なら null で、今までの表示のまま', () => {
        expect(jobProgress('finalSummary', undefined)).toBeNull();
        expect(jobProgress('contextSet', { step: 'parts', done: 1, total: 2 })).toBeNull();
        // 知らない段階（新しいサーバー）も出さない
        expect(jobProgress('finalSummary', { step: 'somethingNew', done: 1, total: 2 })).toBeNull();
    });

    it('おかしな値でも崩れない', () => {
        expect(jobProgress('finalSummary', { step: 'parts', done: 3, total: 0 })).toEqual({
            text: '要約詳細',
            ratio: null,
        });
        expect(jobProgress('finalSummary', { step: 'parts', done: 9, total: 6 })?.ratio).toBe(1);
        expect(jobProgress('finalTranscript', { step: 'transcribe', percent: 50 })).toEqual({
            text: '文字起こし 50%',
            ratio: 0.5,
        });
    });
});
