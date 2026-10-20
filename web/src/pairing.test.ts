import { describe, expect, it } from 'vitest';

import { settled } from '@/components/PairPage';
import { type PairRequest, pairingCode } from '@/pairing';

const base: PairRequest = { code: 'ABCD-EFGH', hostName: 'PC', status: 'pending', answeredByMe: null, expiresAt: 0 };

describe('pairing', () => {
    it('/pair?code= のときだけコードを取り出す', () => {
        expect(pairingCode({ pathname: '/pair', search: '?code=ABCD-EFGH' })).toBe('ABCD-EFGH');
        expect(pairingCode({ pathname: '/pair', search: '' })).toBeNull();
        expect(pairingCode({ pathname: '/s/abc', search: '?code=ABCD-EFGH' })).toBeNull();
    });

    it('申請の状態に合わせて出し分ける（ほかの人が承認したものは知らせる）', () => {
        expect(settled(base)).toBeNull();
        expect(settled({ ...base, status: 'approved', answeredByMe: true })?.kind).toBe('done');
        expect(settled({ ...base, status: 'approved', answeredByMe: false })?.kind).toBe('error');
        expect(settled({ ...base, status: 'rejected', answeredByMe: true })?.kind).toBe('done');
    });
});
