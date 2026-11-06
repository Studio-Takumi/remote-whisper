import { describe, expect, it } from 'vitest';

import { type UnsentSession, splitByHost, unsentSeconds } from '@/audio/unsentStore';

// 1 秒分（16kHz・Int16）のチャンク。先頭 4 バイトは連番
const second = () => ({ seq: 0, frame: new ArrayBuffer(4 + 16000 * 2) });

const entry = (session: string, host: string | null | undefined, seconds = 1): UnsentSession => ({
    session,
    project: 'p',
    ...(host === undefined ? {} : { host }),
    frames: Array.from({ length: seconds }, second),
});

describe('unsentSeconds', () => {
    it('連番の 4 バイトを除いて秒にする', () => {
        expect(unsentSeconds([second(), second(), second()])).toBe(3);
        expect(unsentSeconds([])).toBe(0);
    });
});

describe('splitByHost（#227）', () => {
    it('今つないでいるホストのものだけを復旧に回す', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', 'a'), entry('s2', 'b', 2)], 'b');
        expect(mine?.session).toBe('s2');
        expect(elsewhere).toEqual([{ host: 'a', sessions: ['s1'], seconds: 1 }]);
    });

    it('ほかのホストのものはホストごとにまとめる', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', 'a', 2), entry('s2', 'a', 3), entry('s3', 'c')], 'b');
        expect(mine).toBeNull();
        expect(elsewhere).toEqual([
            { host: 'a', sessions: ['s1', 's2'], seconds: 5 },
            { host: 'c', sessions: ['s3'], seconds: 1 },
        ]);
    });

    it('ダイレクト版（ホストは null）は null の行を今のものとする', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', null)], null);
        expect(mine?.session).toBe('s1');
        expect(elsewhere).toEqual([]);
    });

    it('ホスト ID のない古い行は、今つないでいるホストのものとみなす', () => {
        expect(splitByHost([entry('s1', undefined)], 'a').mine?.session).toBe('s1');
        expect(splitByHost([entry('s1', undefined)], null).mine?.session).toBe('s1');
    });

    it('クラウド版に null の行があっても、復旧にもほかのホストにも回さない', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', null)], 'a');
        expect(mine).toBeNull();
        expect(elsewhere).toEqual([]);
    });

    it('今のホストのものが複数あれば最初の 1 つ、空のものは飛ばす', () => {
        const { mine } = splitByHost([entry('s0', 'a', 0), entry('s1', 'a'), entry('s2', 'a')], 'a');
        expect(mine?.session).toBe('s1');
    });
});
