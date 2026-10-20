import { describe, expect, it } from 'vitest';

import { type Me, addableProviders, canRemove, canSubmitConsent, consentPayload, loginHref } from '@/account';

const me: Me = {
    id: 'u1',
    displayName: 'たろう',
    tosVersion: null,
    tosCurrent: '2026-10-20',
    termsUrl: 'https://example.test/terms',
    privacyUrl: 'https://example.test/privacy',
    dataCollection: false,
    identities: [{ id: 'i1', provider: 'github', email: null, displayName: 'たろう', createdAt: 0 }],
    providers: ['google', 'discord', 'github'],
};

describe('account', () => {
    it('ログインを始める URL', () => {
        expect(loginHref('google')).toBe('/auth/login/google');
        expect(loginHref('github', { link: true, returnTo: '/s/abc' })).toBe(
            '/auth/login/github?link=1&return=%2Fs%2Fabc',
        );
    });

    it('足せるのは、まだ足していない手段だけ', () => {
        expect(addableProviders(me)).toEqual(['google', 'discord']);
    });

    it('同意の本文は今の規約の版を使う', () => {
        expect(consentPayload(me, false)).toEqual({ tosVersion: '2026-10-20', dataCollection: false });
        expect(consentPayload(me, true).dataCollection).toBe(true);
    });

    it('同意して進めるのは、チェックを入れていて送信中でないときだけ', () => {
        expect(canSubmitConsent(false, false)).toBe(false);
        expect(canSubmitConsent(true, true)).toBe(false);
        expect(canSubmitConsent(true, false)).toBe(true);
    });

    it('最後の 1 つは外せない', () => {
        expect(canRemove(me)).toBe(false);
        expect(canRemove({ ...me, identities: [...me.identities, { ...me.identities[0], id: 'i2' }] })).toBe(true);
    });
});
