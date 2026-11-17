import { describe, expect, it } from 'vitest';

import type { LiveSource } from '@/api/protocol';
import {
    describeSourceSpan,
    keepLineSources,
    listSources,
    mergeUnavailable,
    newlyDisconnected,
    sourceKindLabel,
    sourceNames,
    sourceTitle,
    withLineSources,
} from '@/features/session/sources';

const a = { time: '00:00:01', text: 'a' };
const b = { time: '00:00:05', text: 'b' };

describe('withLineSources', () => {
    it('行の数と合えば、行ごとの音源を付ける', () => {
        expect(withLineSources([a, b], [1, 2])).toEqual([
            { ...a, source: 1 },
            { ...b, source: 2 },
        ]);
    });

    it('ない・空なら付けない（音源が 1 つのセッション）', () => {
        expect(withLineSources([a, b], undefined)).toEqual([a, b]);
        expect(withLineSources([a, b], [])).toEqual([a, b]);
    });

    it('行の数より短ければ、足りない行は主の音源とみなす（spec/flows.md 6.16）', () => {
        expect(withLineSources([a, b], [2])).toEqual([
            { ...a, source: 2 },
            { ...b, source: 1 },
        ]);
    });
});

describe('keepLineSources', () => {
    it('取り直した行に音源がなければ、手元の同じ行の音源を残す（録音中はフロントマターにまだない）', () => {
        expect(
            keepLineSources(
                [a, { ...b, text: 'B' }],
                [
                    { ...a, source: 2 },
                    { ...b, source: 1 },
                ],
            ),
        ).toEqual([
            { ...a, source: 2 },
            { ...b, text: 'B', source: 1 },
        ]);
    });

    it('取り直した行に音源があれば、そちらを使う', () => {
        const fetched = [{ ...a, source: 1 }];
        expect(keepLineSources(fetched, [{ ...a, source: 2 }])).toBe(fetched);
    });

    it('時刻が違う行には付けない', () => {
        expect(keepLineSources([b], [{ ...a, source: 2 }])).toEqual([b]);
    });
});

const live: LiveSource[] = [
    { id: 1, name: 'Mac', kind: 'main', state: 'active' },
    { id: 2, name: 'iPhone', kind: 'join', state: 'active' },
];

describe('listSources', () => {
    const stored = [
        { id: 1, name: null, kind: 'main' as const },
        { id: 2, name: 'iPhone', kind: 'join' as const, joinedSec: 30, leftSec: null },
    ];

    it('音源が 1 つなら空（音源が 1 つのセッションの見た目は変えない）', () => {
        expect(listSources(undefined, [live[0]], true)).toEqual([]);
        expect(listSources([stored[0]], undefined, false)).toEqual([]);
    });

    it('録音中は sources のメッセージ、録音を終えたらフロントマター', () => {
        expect(listSources(stored, live, true).map((s) => s.live)).toEqual([true, true]);
        expect(listSources(stored, live, false)[1]).toEqual({
            id: 2,
            name: 'iPhone',
            kind: 'join',
            live: false,
            joinedSec: 30,
            leftSec: null,
        });
    });

    it('録音を終えても、フロントマターを読み直すまでは録音中の一覧', () => {
        expect(listSources(undefined, live, false).map((s) => s.id)).toEqual([1, 2]);
    });
});

describe('describeSourceSpan', () => {
    it('参加していた時間（主の音源の時刻）', () => {
        expect(describeSourceSpan({ id: 1, name: null, kind: 'main', live: false }, 600, false)).toBe(
            '00:00:00〜00:10:00',
        );
        expect(
            describeSourceSpan(
                { id: 2, name: 'x', kind: 'join', live: false, joinedSec: 65, leftSec: 125 },
                600,
                false,
            ),
        ).toBe('00:01:05〜00:02:05');
        // 抜けていなければ終わりまで
        expect(
            describeSourceSpan(
                { id: 2, name: 'x', kind: 'join', live: false, joinedSec: 65, leftSec: null },
                600,
                false,
            ),
        ).toBe('00:01:05〜00:10:00');
    });

    it('ファイルはファイル全体、録音中はつながっているか', () => {
        expect(describeSourceSpan({ id: 2, name: 'b.m4a', kind: 'upload', live: false }, 600, true)).toBe(
            'ファイル全体',
        );
        expect(
            describeSourceSpan({ id: 2, name: 'x', kind: 'join', live: true, state: 'disconnected' }, 0, false),
        ).toBe('切れています');
    });
});

describe('sourceKindLabel', () => {
    it('録音した端末 / 参加した端末 / ファイル。アップロードの主の音源はファイル', () => {
        expect(sourceKindLabel('main', false)).toBe('録音した端末');
        expect(sourceKindLabel('join', false)).toBe('参加した端末');
        expect(sourceKindLabel('upload', true)).toBe('ファイル');
        expect(sourceKindLabel('main', true)).toBe('ファイル');
    });
});

describe('sourceTitle・sourceNames', () => {
    it('名前があれば括弧で付ける', () => {
        expect(sourceTitle(2, 'iPhone')).toBe('音源 2（iPhone）');
        expect(sourceTitle(1, null)).toBe('音源 1');
        expect(sourceNames(live)).toEqual({ 1: 'Mac', 2: 'iPhone' });
    });
});

describe('newlyDisconnected', () => {
    it('つながっていた音源が切れたものだけ', () => {
        const after: LiveSource[] = [
            { ...live[0] },
            { ...live[1], state: 'disconnected' },
            { id: 3, name: 'Android', kind: 'join', state: 'disconnected' },
        ];
        expect(newlyDisconnected(live, after).map((s) => s.id)).toEqual([2]);
        // 切れたままの音源・初めて届いた一覧では知らせない
        expect(newlyDisconnected(after, after)).toEqual([]);
        expect(newlyDisconnected(undefined, after)).toEqual([]);
    });
});

describe('mergeUnavailable', () => {
    it('古いホスト・上限 1・上限を超えたときは理由を返す', () => {
        expect(mergeUnavailable(2, undefined)).toBe('このホストは複数の音源に対応していません');
        expect(mergeUnavailable(2, 1)).toBe('このホストではまとめられない設定です');
        expect(mergeUnavailable(5, 4)).toBe('まとめられるのは 4 個までです');
        expect(mergeUnavailable(4, 4)).toBeNull();
    });
});
