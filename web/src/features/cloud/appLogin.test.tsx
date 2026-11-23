// アプリの中のログインの画面（#441）。ブラウザ版はリンク（Cookie のログイン）のまま、アプリの中のクラウド版だけ
// システムのログイン画面を出す。アプリの端末は、なければ何も出さない
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ active: false, login: vi.fn() }));

vi.mock('@/api/appAuth', () => ({
    get appAuthActive() {
        return auth.active;
    },
    appLogin: auth.login,
    isCanceled: (e: { code?: string }) => e.code === 'canceled',
    withAppAuth: (init: RequestInit) => init,
    appLogout: async () => undefined,
    appForget: async () => undefined,
}));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    auth.login.mockReset();
});

describe('ログインのボタン', () => {
    it('ブラウザ版はリンクのまま', async () => {
        auth.active = false;
        const { LoginButtons } = await import('@/features/cloud/LoginButtons');
        render(<LoginButtons />);
        const link = screen.getByRole('link', { name: 'Google でログイン' });
        expect(link.getAttribute('href')).toContain('/auth/login/google');
        expect(auth.login).not.toHaveBeenCalled();
    });

    it('アプリの中では、システムのログイン画面を出す（やめてもエラーを出さない）', async () => {
        auth.active = true;
        auth.login.mockRejectedValue(Object.assign(new Error('canceled'), { code: 'canceled' }));
        const { LoginButtons } = await import('@/features/cloud/LoginButtons');
        render(<LoginButtons />);
        expect(screen.queryByRole('link')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'GitHub でログイン' }));
        await waitFor(() => expect(auth.login).toHaveBeenCalledWith('github'));
    });
});

describe('アプリの端末', () => {
    it('なければ何も出さず、あれば一覧と外すボタンを出す（この端末には出さない）', async () => {
        const { DevicesSection } = await import('@/features/cloud/DevicesSection');
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => Response.json({ devices: [] })),
        );
        const empty = render(<DevicesSection open />);
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(empty.container.textContent).toBe('');
        cleanup();
        vi.stubGlobal(
            'fetch',
            vi.fn(async () =>
                Response.json({
                    devices: [
                        { id: 'a', name: 'たろうの iPhone', createdAt: 1, lastSeenAt: 1, current: true },
                        { id: 'b', name: 'iPad', createdAt: 1, lastSeenAt: 1, current: false },
                    ],
                }),
            ),
        );
        render(<DevicesSection open />);
        await screen.findByText('アプリの端末');
        expect(screen.getByText('この端末')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: '外す' })).toHaveLength(1);
    });
});
