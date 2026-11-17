import { describe, expect, it } from 'vitest';

import { parseSpeaker, speakerColor } from '@/features/session/speakerLine';

describe('parseSpeaker', () => {
    it('「話者 N: 」で始まる行だけ分ける（改行を含んでもよい）', () => {
        expect(parseSpeaker('話者 2: こんにちは')).toEqual({ speaker: '2', text: 'こんにちは' });
        expect(parseSpeaker('話者 1: 一行目\n二行目')).toEqual({ speaker: '1', text: '一行目\n二行目' });
        expect(parseSpeaker('こんにちは')).toBeNull();
        expect(parseSpeaker('話者1: こんにちは')).toBeNull();
    });
});

describe('speakerColor', () => {
    it('6 色を順に使い回す', () => {
        expect(speakerColor('1')).toContain('sky');
        expect(speakerColor('6')).toContain('indigo');
        expect(speakerColor('7')).toBe(speakerColor('1'));
    });
});
