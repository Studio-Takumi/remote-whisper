import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';

import {
    type UnsentSession,
    clearSession,
    listUnsent,
    saveChunk,
    splitByHost,
    unsentSeconds,
} from '@/audio/unsentStore';

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

    it('セルフホスト版（ホストは null）は null の行を今のものとする', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', null)], null);
        expect(mine?.session).toBe('s1');
        expect(elsewhere).toEqual([]);
    });

    it('セルフホスト版では、ホスト ID のない古い行も今のものとする', () => {
        expect(splitByHost([entry('s1', undefined)], null).mine?.session).toBe('s1');
    });

    it('クラウド版では、ホスト ID のない古い行と null の行は今のホストに送らず、分からないものにまとめる', () => {
        const { mine, elsewhere } = splitByHost([entry('s1', undefined), entry('s2', null, 2)], 'a');
        expect(mine).toBeNull();
        expect(elsewhere).toEqual([{ host: null, sessions: ['s1', 's2'], seconds: 3 }]);
    });

    it('今のホストのものが複数あれば最初の 1 つ、空のものは飛ばす', () => {
        const { mine } = splitByHost([entry('s0', 'a', 0), entry('s1', 'a'), entry('s2', 'a')], 'a');
        expect(mine?.session).toBe('s1');
    });
});

// IndexedDB（fake-indexeddb）に置いて読み直す。host が行に入らないと、どれも分からないものになり、
// ほかのホストのものを見分けられなくなる
describe('saveChunk・listUnsent のホスト（#227）', () => {
    const frame = () => new ArrayBuffer(4 + 16000 * 2);

    it('置いたときのホストを行に持ち、読むときに返す', async () => {
        await saveChunk('s-a', 'p', 'host-a', 0, frame());
        await saveChunk('s-a', 'p', 'host-a', 1, frame());
        await saveChunk('s-b', 'q', 'host-b', 0, frame());
        await saveChunk('s-d', 'p', null, 0, frame());
        const list = await listUnsent();
        const by = (s: string) => list.find((e) => e.session === s);
        expect(by('s-a')).toMatchObject({ project: 'p', host: 'host-a' });
        expect(by('s-a')?.frames.map((f) => f.seq)).toEqual([0, 1]);
        expect(by('s-b')).toMatchObject({ project: 'q', host: 'host-b' });
        expect(by('s-d')?.host).toBeNull();

        const { mine, elsewhere } = splitByHost(list, 'host-b');
        expect(mine?.session).toBe('s-b');
        expect(elsewhere.map((e) => e.host).sort()).toEqual(['host-a', null].sort());

        for (const s of ['s-a', 's-b', 's-d']) {
            await clearSession(s);
        }
        expect(await listUnsent()).toEqual([]);
    });
});
