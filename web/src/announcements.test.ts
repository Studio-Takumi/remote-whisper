import { describe, expect, it, vi } from 'vitest';

import {
    fetchAnnouncements,
    isActive,
    loadSeen,
    parseAnnouncements,
    pickVisible,
    safeHttpsUrl,
    saveSeen,
} from '@/announcements';
import type { Announcement } from '@/announcements';

const item = (over: Partial<Announcement> = {}): Announcement => ({
    id: 'a1',
    kind: 'info',
    title: 'お知らせ',
    url: 'https://example.test/a',
    since: '2026-10-01',
    until: '2026-10-31',
    ...over,
});

const at = (s: string) => Date.parse(s);

describe('お知らせの期間', () => {
    it('since から until までの間だけ出す。日付だけの until はその日いっぱい', () => {
        expect(isActive(item(), at('2026-09-30T23:59:59Z'))).toBe(false);
        expect(isActive(item(), at('2026-10-01T00:00:00Z'))).toBe(true);
        expect(isActive(item(), at('2026-10-31T23:59:59Z'))).toBe(true);
        expect(isActive(item(), at('2026-11-01T00:00:00Z'))).toBe(false);
    });
    it('日時で書いた until はその時刻まで', () => {
        const a = item({ until: '2026-10-31T12:00:00Z' });
        expect(isActive(a, at('2026-10-31T11:59:59Z'))).toBe(true);
        expect(isActive(a, at('2026-10-31T12:00:00Z'))).toBe(false);
    });
    it('読めない日付は出さない', () => {
        expect(isActive(item({ since: 'いつか' }), at('2026-10-10'))).toBe(false);
    });
});

describe('見ていないものを選ぶ', () => {
    const all = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c', until: '2026-10-02' })];
    it('既読と期間外を外す', () => {
        expect(pickVisible(all, new Set(['a']), at('2026-10-20T00:00:00Z')).map((a) => a.id)).toEqual(['b']);
        expect(pickVisible(all, new Set(), at('2026-10-02T00:00:00Z')).map((a) => a.id)).toEqual(['a', 'b', 'c']);
    });
});

describe('読み込み', () => {
    it('形の合わない項目は捨てる', () => {
        const list = parseAnnouncements([
            item(),
            { id: 'x', kind: 'ad', title: 't', since: '2026-10-01', until: '2026-10-02' },
            { id: '', kind: 'info', title: 't', since: 's', until: 'u' },
            'text',
            null,
            { ...item({ id: 'r', kind: 'release' }), version: '1.2.0' },
        ]);
        expect(list.map((a) => a.id)).toEqual(['a1', 'r']);
        expect(list[1].version).toBe('1.2.0');
        expect(parseAnnouncements({ not: 'array' })).toEqual([]);
    });
    it('https の URL だけをリンクにする', () => {
        expect(safeHttpsUrl('https://example.test/x')).toBe('https://example.test/x');
        expect(safeHttpsUrl('http://example.test/x')).toBeNull();
        expect(safeHttpsUrl('javascript:alert(1)')).toBeNull();
        expect(safeHttpsUrl('')).toBeNull();
    });
});

describe('ダイレクト版は読みに行かない', () => {
    it('クラウド版でなければ、fetch を呼ばない', async () => {
        const fetchFn = vi.fn();
        expect(await fetchAnnouncements(false, fetchFn as unknown as typeof fetch)).toEqual([]);
        expect(fetchFn).not.toHaveBeenCalled();
    });
    it('クラウド版なら announcements.json を読む。失敗しても落ちない', async () => {
        const ok = vi.fn().mockResolvedValue({ ok: true, json: async () => [item()] });
        expect(await fetchAnnouncements(true, ok as unknown as typeof fetch)).toHaveLength(1);
        expect(ok.mock.calls[0][0]).toBe('/announcements.json');
        const bad = vi.fn().mockRejectedValue(new Error('offline'));
        expect(await fetchAnnouncements(true, bad as unknown as typeof fetch)).toEqual([]);
        const broken = vi.fn().mockResolvedValue({
            ok: true,
            json: async () => {
                throw new SyntaxError('x');
            },
        });
        expect(await fetchAnnouncements(true, broken as unknown as typeof fetch)).toEqual([]);
    });
});

describe('既読', () => {
    it('保存して読み戻せる。壊れていても落ちない', () => {
        const store = new Map<string, string>();
        const storage = {
            getItem: (k: string) => store.get(k) ?? null,
            setItem: (k: string, v: string) => void store.set(k, v),
        };
        saveSeen(new Set(['a', 'b']), storage);
        expect([...loadSeen(storage)]).toEqual(['a', 'b']);
        expect(loadSeen({ getItem: () => '{oops' }).size).toBe(0);
        const throwing = {
            getItem: () => {
                throw new Error('blocked');
            },
            setItem: () => {
                throw new Error('blocked');
            },
        };
        expect(loadSeen(throwing).size).toBe(0);
        expect(() => saveSeen(new Set(['a']), throwing)).not.toThrow();
    });
});
