// ホストの新しい版の知らせ（#472）。設定画面のバージョンの下に出し、トーストは版ごとに 1 回だけ
import { act, cleanup, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HostUpdateNotice } from '@/app/HostUpdateNotice';
import { NOTIFIED_KEY } from '@/app/hostUpdate';
import { useAppStore } from '@/app/store';
import { hostUpdateOf, minorVersion } from '@/app/version';
import { VersionInfo } from '@/features/settings/VersionInfo';

const NOTES = 'https://github.com/Studio-Takumi/remote-whisper/releases/tag/v1.1.0';
const V11 = { version: 'v1.1.0', url: NOTES };
const initial = useAppStore.getState();

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(toast, 'info').mockImplementation(() => '');
});

afterEach(() => {
    cleanup();
    useAppStore.setState(initial, true);
    vi.restoreAllMocks();
});

describe('知らせる版', () => {
    it('updateAvailable のときだけ。リリースノートは https のものだけ', () => {
        expect(hostUpdateOf({ version: 'v1.0.0', latest: V11, updateAvailable: true })).toEqual(V11);
        expect(hostUpdateOf({ version: 'v1.1.0+abc', latest: V11, updateAvailable: false })).toBeNull();
        expect(hostUpdateOf({ version: 'v1.0.0', latest: null, updateAvailable: false })).toBeNull();
        // 古いサーバー（latest がない）
        expect(hostUpdateOf({ version: 'v1.0.0' })).toBeNull();
        expect(
            hostUpdateOf({
                version: 'v1.0.0',
                latest: { version: 'v1.1.0', url: 'javascript:alert(1)' },
                updateAvailable: true,
            }),
        ).toBeNull();
    });

    it('画面に出す名前は x.y', () => {
        expect(minorVersion('v1.1.0')).toBe('v1.1');
        expect(minorVersion('v10.20.3')).toBe('v10.20');
    });
});

describe('設定画面のバージョンの下', () => {
    it('新しい版があれば「v1.1 が出ています」とリリースノートへのリンクを出す', () => {
        useAppStore.setState({ serverVersion: 'v1.0.0', hostUpdate: V11 });
        render(<VersionInfo />);
        expect(screen.getByText(/v1\.1 が出ています/)).toBeTruthy();
        const link = screen.getByRole('link', { name: 'リリースノート' });
        expect(link.getAttribute('href')).toBe(NOTES);
        expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('なければ出さない', () => {
        useAppStore.setState({ serverVersion: 'v1.0.0', hostUpdate: null });
        render(<VersionInfo />);
        expect(screen.queryByText(/が出ています/)).toBeNull();
    });
});

describe('トースト', () => {
    it('版ごとに 1 回だけ出す。出した版は覚えて、開き直しても出さない', () => {
        useAppStore.setState({ hostUpdate: V11 });
        render(<HostUpdateNotice />);
        expect(toast.info).toHaveBeenCalledTimes(1);
        expect(vi.mocked(toast.info).mock.calls[0][0]).toBe('v1.1 が出ています');
        expect(localStorage.getItem(NOTIFIED_KEY)).toBe('v1.1.0');

        // 同じ版を取り直しても、画面を開き直しても出さない
        act(() => useAppStore.setState({ hostUpdate: { ...V11 } }));
        cleanup();
        render(<HostUpdateNotice />);
        expect(toast.info).toHaveBeenCalledTimes(1);

        // 次の版では出す
        act(() => useAppStore.setState({ hostUpdate: { version: 'v1.2.0', url: NOTES } }));
        expect(toast.info).toHaveBeenCalledTimes(2);
    });

    it('新しい版がなければ出さない', () => {
        render(<HostUpdateNotice />);
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('localStorage が使えなくても、開いている間は 1 回だけ', () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('denied');
        });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('denied');
        });
        const v13 = { version: 'v1.3.0', url: NOTES };
        useAppStore.setState({ hostUpdate: v13 });
        render(<HostUpdateNotice />);
        act(() => useAppStore.setState({ hostUpdate: { ...v13 } }));
        cleanup();
        render(<HostUpdateNotice />);
        expect(toast.info).toHaveBeenCalledTimes(1);
    });
});
