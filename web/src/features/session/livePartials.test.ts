import { describe, expect, it } from 'vitest';

import { dropPartial, partialsOf, upsertPartial } from '@/features/session/livePartials';

const p = (segment: number, source?: number, sessionId = 's1') => ({
    sessionId,
    segment,
    committed: `c${segment}`,
    tentative: '',
    ...(source === undefined ? {} : { source }),
});

describe('partial を音源ごとに持つ（#356）', () => {
    it('音源が 1 つ（source なし）なら、1 つだけを置き換える（今までと同じ）', () => {
        let list = upsertPartial([], p(0));
        list = upsertPartial(list, p(1));
        expect(list).toEqual([p(1)]);
    });

    it('音源ごとに 1 つずつ持ち、同じ segment の final で消す', () => {
        let list = upsertPartial([], p(3, 1));
        list = upsertPartial(list, p(4, 2));
        list = upsertPartial(list, p(5, 1));
        expect(list).toEqual([p(4, 2), p(5, 1)]);
        // segment は通し番号なので、ほかの音源の final で消えない
        expect(dropPartial(list, 's1', 3)).toBe(list);
        expect(dropPartial(list, 's1', 4)).toEqual([p(5, 1)]);
    });

    it('セッションごとに分ける', () => {
        const list = [p(0, 1, 's1'), p(0, 1, 's2')];
        expect(upsertPartial(list, p(1, 1, 's2'))).toEqual([p(0, 1, 's1'), p(1, 1, 's2')]);
        expect(partialsOf(list, 's2')).toEqual([p(0, 1, 's2')]);
        expect(dropPartial(list, 's2', 0)).toEqual([p(0, 1, 's1')]);
    });
});
