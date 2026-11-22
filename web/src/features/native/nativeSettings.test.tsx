// iOS アプリの中の設定の見た目（spec/mobile.md 11.4）。ブラウザと同じページの並びで、
// ブラウザではネイティブを呼ぶコード（nativeBridge・@capacitor/core）も読み込まないこと
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsOptions } from '@/api/protocol';
import { SETTINGS_PAGES, defaultSettings } from '@/features/settings/settings';

// 読み込まれたかを数える（vi.mock の中から触るので vi.hoisted にする）。
// テストごとに vi.resetModules() で読み込み直すので、並び順に依存しない
const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));

const startShell = vi.hoisted(() => vi.fn());

vi.mock('@/features/native/nativeBridge', () => {
    loaded.bridge++;
    return { startNativeShell: startShell };
});

vi.mock('@capacitor/core', () => {
    loaded.core++;
    return {};
});

const options: SettingsOptions = {
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16', 'int8'] },
    llm: { backend: 'ollama', models: [{ name: 'gemma4:e4b', thinking: true }] },
};

function setCapacitor(capacitor: { isNativePlatform: () => boolean } | null) {
    const w = window as { Capacitor?: unknown };
    if (capacitor) {
        w.Capacitor = capacitor;
    } else {
        delete w.Capacitor;
    }
}

const setNative = () => setCapacitor({ isNativePlatform: () => true });

async function draw(page: string) {
    const { SettingsDialog } = await import('@/features/settings/SettingsDialog');
    render(
        <QueryClientProvider client={new QueryClient()}>
            <SettingsDialog
                open
                page={page}
                onOpenChange={vi.fn()}
                onPageChange={vi.fn()}
                settings={defaultSettings}
                loaded
                onRetry={vi.fn()}
                options={options}
                recording={false}
                onSave={vi.fn()}
            />
        </QueryClientProvider>,
    );
}

// dynamic import が走る余地を与える
const settle = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
    vi.resetModules();
    loaded.bridge = 0;
    loaded.core = 0;
    startShell.mockClear();
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
    cleanup();
    setCapacitor(null);
    document.documentElement.classList.remove('rw-native');
});

describe('iOS アプリの中の設定', () => {
    it('ブラウザでは出さず、/settings/ios は最初のページになる。ネイティブのコードも読み込まない', async () => {
        await draw('ios');
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(SETTINGS_PAGES.length);
        expect(screen.queryByRole('tab', { name: 'iOS アプリ' })).toBeNull();
        expect(screen.getByRole('tab', { name: 'モデル' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByText('録音開始')).toBeNull();
        // ほかのタブのボタンは今までどおり
        expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
        await settle();
        expect(loaded.bridge).toBe(0);
        expect(loaded.core).toBe(0);
    });

    it('window.Capacitor があっても isNativePlatform() が false ならブラウザとして扱う', async () => {
        setCapacitor({ isNativePlatform: () => false });
        const { isNativeApp, startNativeShell } = await import('@/features/native/nativePlatform');
        expect(isNativeApp()).toBe(false);
        startNativeShell();
        await draw('ios');
        await settle();
        expect(document.documentElement.classList.contains('rw-native')).toBe(false);
        expect(loaded.bridge).toBe(0);
    });

    it('startNativeShell はブラウザでは何もしない', async () => {
        const { startNativeShell } = await import('@/features/native/nativePlatform');
        startNativeShell();
        await settle();
        expect(document.documentElement.classList.contains('rw-native')).toBe(false);
        expect(loaded.bridge).toBe(0);
    });

    it('アプリの中でもページの並びはブラウザと同じで、/settings/ios（古いブックマーク）は最初のページになる', async () => {
        setNative();
        await draw('ios');
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(SETTINGS_PAGES.length);
        expect(screen.queryByRole('tab', { name: 'iOS アプリ' })).toBeNull();
        expect(screen.getByRole('tab', { name: 'モデル' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'キャンセル' })).toBeTruthy();
    });

    it('アプリの中では startNativeShell が <html> に rw-native を付け、ネイティブの側を始める', async () => {
        setNative();
        const { startNativeShell } = await import('@/features/native/nativePlatform');
        startNativeShell();
        expect(document.documentElement.classList.contains('rw-native')).toBe(true);
        await waitFor(() => expect(startShell).toHaveBeenCalledTimes(1));
    });
});
