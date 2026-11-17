import { describe, expect, it } from 'vitest';

import { pickFinalTranscript } from '@/api/data';
import type { FinalTranscriptInfo } from '@/api/types';

function info(generationId: string, model: string): FinalTranscriptInfo {
    return { generationId, model, generatedAt: '', diarization: 'off', speakers: 0 };
}

describe('pickFinalTranscript', () => {
    const infos = [info('g1', 'turbo'), info('g2', 'small'), info('g3', 'turbo'), info('g4', 'small')];

    it('今の Whisper のモデルで作ったうち、いちばん新しいもの', () => {
        expect(pickFinalTranscript(infos, 'turbo')?.generationId).toBe('g3');
    });

    it('そのモデルのものがなければ、モデルを問わずいちばん新しいもの', () => {
        expect(pickFinalTranscript(infos, 'large-v3')?.generationId).toBe('g4');
    });

    it('版がなければない', () => {
        expect(pickFinalTranscript([], 'turbo')).toBeUndefined();
    });
});
