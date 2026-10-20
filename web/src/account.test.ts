import { describe, expect, it } from 'vitest';

import { type Me, addableProviders, canRemove, loginHref } from '@/account';

const me: Me = {
    id: 'u1',
    displayName: 'たろう',
    tosVersion: null,
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

    it('最後の 1 つは外せない', () => {
        expect(canRemove(me)).toBe(false);
        expect(canRemove({ ...me, identities: [...me.identities, { ...me.identities[0], id: 'i2' }] })).toBe(true);
    });
});
