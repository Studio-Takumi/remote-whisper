import { describe, expect, it, vi } from 'vitest';

import {
    type Me,
    addableProviders,
    canRemove,
    canSubmitConsent,
    consentPayload,
    loginHref,
    logoutEverywhere,
    request,
} from '@/features/cloud/account';
import { setLanguage } from '@/i18n/language';

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

    it('すべての端末からログアウトは DELETE /me/sessions を呼ぶ', async () => {
        const fetchMock = vi.fn(async () => Response.json({ ok: true }));
        vi.stubGlobal('fetch', fetchMock);
        await logoutEverywhere();
        expect(fetchMock).toHaveBeenCalledWith('/me/sessions', expect.objectContaining({ method: 'DELETE' }));
        vi.unstubAllGlobals();
    });

    it('中間サーバーのエラーは、コードから引いた文と status の Error にする（#495）', async () => {
        setLanguage('en');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json(
                    { detail: '最後のログイン手段は外せません', code: 'loginMethod.lastOne', params: {} },
                    { status: 409 },
                ),
            ),
        );
        await expect(request('/me/identities/i1')).rejects.toMatchObject({
            message: "You can't remove your last login method",
            status: 409,
        });
        setLanguage('ja');
        await expect(request('/me/identities/i1')).rejects.toThrow('最後のログイン手段は外せません');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ detail: '古い中間サーバーの文' }, { status: 404 })),
        );
        await expect(request('/me/hosts/h1')).rejects.toThrow('古い中間サーバーの文');
        vi.unstubAllGlobals();
    });

    it('最後の 1 つは外せない', () => {
        expect(canRemove(me)).toBe(false);
        expect(canRemove({ ...me, identities: [...me.identities, { ...me.identities[0], id: 'i2' }] })).toBe(true);
    });
});
