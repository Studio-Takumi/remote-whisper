// 画面をアプリに同梱したときの接続先の画面（#440。spec/mobile.md 11.9）
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadAppEndpoint } from '@/features/native/appEndpoint';

beforeEach(() => {
    localStorage.clear();
});
afterEach(() => {
    cleanup();
    vi.doUnmock('@/api/endpoint');
    vi.resetModules();
});

describe('接続先の画面', () => {
    it('形の違う URL は保存せずに知らせる', async () => {
        const { AppEndpointSetup } = await import('@/features/native/AppEndpointSetup');
        const onSaved = vi.fn();
        render(<AppEndpointSetup onSaved={onSaved} />);
        fireEvent.change(screen.getByLabelText('ホストの URL'), { target: { value: 'https://pc.example/path' } });
        fireEvent.click(screen.getByRole('button', { name: 'つなぐ' }));
        expect(screen.getByRole('alert')).toBeTruthy();
        expect(onSaved).not.toHaveBeenCalled();
        expect(loadAppEndpoint()).toBeNull();
    });

    it('そろえた URL だけを保存して読み込み直す（モードは保存しない）', async () => {
        const { AppEndpointSetup } = await import('@/features/native/AppEndpointSetup');
        const onSaved = vi.fn();
        render(<AppEndpointSetup onSaved={onSaved} />);
        fireEvent.change(screen.getByLabelText('ホストの URL'), { target: { value: 'pc.example.ts.net' } });
        fireEvent.click(screen.getByRole('button', { name: 'つなぐ' }));
        expect(onSaved).toHaveBeenCalledOnce();
        expect(loadAppEndpoint()).toEqual({ url: 'https://pc.example.ts.net' });
        expect(JSON.parse(localStorage.getItem('remote-whisper.appEndpoint')!)).toEqual({
            url: 'https://pc.example.ts.net',
        });
    });
});

describe('設定の接続先', () => {
    it('ブラウザ版では何も出さない', async () => {
        const { AppEndpointInfo } = await import('@/features/native/AppEndpointSetup');
        const { container } = render(<AppEndpointInfo />);
        expect(container.innerHTML).toBe('');
    });

    it('同梱したときは今の接続先を出し、「変える」で消して読み込み直す', async () => {
        vi.doMock('@/api/endpoint', async (importOriginal) => ({
            ...(await importOriginal<typeof import('@/api/endpoint')>()),
            bundled: true,
            endpoint: { base: 'https://pc.example.ts.net', mode: 'direct', unset: false },
        }));
        localStorage.setItem('remote-whisper.appEndpoint', JSON.stringify({ url: 'https://pc.example.ts.net' }));
        const { AppEndpointInfo } = await import('@/features/native/AppEndpointSetup');
        const onCleared = vi.fn();
        render(<AppEndpointInfo onCleared={onCleared} />);
        expect(screen.getByText('https://pc.example.ts.net')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '変える' }));
        expect(onCleared).toHaveBeenCalledOnce();
        expect(loadAppEndpoint()).toBeNull();
    });
});
