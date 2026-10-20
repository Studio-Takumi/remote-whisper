import { describe, expect, it } from 'vitest';

import { pairingCode } from '@/pairing';

describe('pairing', () => {
    it('/pair?code= のときだけコードを取り出す', () => {
        expect(pairingCode({ pathname: '/pair', search: '?code=ABCD-EFGH' })).toBe('ABCD-EFGH');
        expect(pairingCode({ pathname: '/pair', search: '' })).toBeNull();
        expect(pairingCode({ pathname: '/s/abc', search: '?code=ABCD-EFGH' })).toBeNull();
    });
});
