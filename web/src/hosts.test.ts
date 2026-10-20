import { describe, expect, it } from 'vitest';

import { type Host, pickHost } from '@/hosts';

const host = (id: string, online: boolean | null = true): Host => ({
    id,
    name: id,
    appVersion: null,
    createdAt: 0,
    lastSeenAt: null,
    online,
});

describe('pickHost', () => {
    it('0 台なら登録の案内', () => {
        expect(pickHost([], null)).toEqual({ kind: 'none' });
    });

    it('1 台ならそのままつなぐ（オンラインか分からなくても）。オフラインなら選ぶ画面で知らせる', () => {
        expect(pickHost([host('a')], null)).toEqual({ kind: 'connect', host: host('a') });
        expect(pickHost([host('a', null)], null)).toMatchObject({ kind: 'connect' });
        expect(pickHost([host('a', false)], null)).toEqual({ kind: 'choose' });
    });

    it('2 台以上は、前に選んだものが選べればそれにつなぎ、なければ選ぶ', () => {
        const hosts = [host('a'), host('b'), host('c', false)];
        expect(pickHost(hosts, 'b')).toEqual({ kind: 'connect', host: host('b') });
        expect(pickHost(hosts, null)).toEqual({ kind: 'choose' });
        expect(pickHost(hosts, 'c')).toEqual({ kind: 'choose' });
        expect(pickHost(hosts, 'gone')).toEqual({ kind: 'choose' });
    });
});
