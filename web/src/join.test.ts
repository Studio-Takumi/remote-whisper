import { afterEach, describe, expect, it } from 'vitest';

import { UNSUPPORTED, deviceName, forgetJoin, joinUnavailable, recalledJoin, rememberJoin } from '@/join';

describe('録音中の参加（#356）', () => {
    afterEach(() => sessionStorage.clear());

    it('古いサーバー（join が来ない）では押せない', () => {
        expect(joinUnavailable(undefined)).toBe(UNSUPPORTED);
        expect(joinUnavailable({ available: true })).toBeNull();
        expect(joinUnavailable({ available: false, reason: 'limit' })).toBe('参加できる音源の数に達しています');
        expect(joinUnavailable({ available: false, reason: 'disabled' })).toBe('このホストでは参加できない設定です');
    });

    it('参加している音源をセッションごとに覚え、読み込み直したら同じ音源としてつなぎ直す', () => {
        expect(recalledJoin('s1')).toBeNull();
        rememberJoin('s1', 2, 15);
        expect(recalledJoin('s1')).toEqual({ source: 2, nextSeq: 15 });
        expect(recalledJoin('s2')).toBeNull();
        forgetJoin('s1');
        expect(recalledJoin('s1')).toBeNull();
        sessionStorage.setItem('rw-join:s3', '{broken');
        expect(recalledJoin('s3')).toBeNull();
    });

    it('端末の大まかな名前', () => {
        expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
        expect(deviceName('Mozilla/5.0 (Linux; Android 15)')).toBe('Android');
        expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
        expect(deviceName('curl')).toBe('ブラウザ');
    });
});
