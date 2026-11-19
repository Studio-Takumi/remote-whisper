// iOS アプリの中でだけ出す「iOS アプリ」タブ（#438。spec/mobile.md 11.4）。ブラウザでは出さず、
// ネイティブを呼ぶコード（nativeBridge・@capacitor/core）も読み込まないこと
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsOptions } from '@/api/protocol';
import type { RecorderPlugin } from '@/features/native/recorderTypes';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { SETTINGS_PAGES, defaultSettings } from '@/features/settings/settings';

// 読み込まれたかを数える（vi.mock の中から触るので vi.hoisted にする）
const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));

const fakeRecorder = vi.hoisted(
    () =>
        ({
            start: async () => ({ file: 'recording-20261119-120000.wav' }),
            stop: async () => ({ file: {} }),
            getStatus: async () => ({ state: 'idle', seconds: 0 }),
            listRecordings: async () => ({ files: [] }),
            readRecording: async () => ({ data: '', offset: 0, size: 0 }),
            deleteRecording: async () => {},
            addListener: async () => ({ remove: async () => {} }),
        }) as unknown as RecorderPlugin,
);

const startShell = vi.hoisted(() => vi.fn());

// 一度読み込むとモジュールは使い回されるので、読み込まれたかを見るテスト（ブラウザ）を先に並べる
vi.mock('@/features/native/nativeBridge', () => {
    loaded.bridge++;
    return { Recorder: fakeRecorder, startNativeShell: startShell };
});

vi.mock('@capacitor/core', () => {
    loaded.core++;
    return {};
});

const options: SettingsOptions = {
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16', 'int8'] },
    llm: { backend: 'ollama', models: [{ name: 'gemma4:e4b', thinking: true }] },
};

function setNative(native: boolean) {
    const w = window as { Capacitor?: unknown };
    if (native) {
        w.Capacitor = { isNativePlatform: () => true };
    } else {
        delete w.Capacitor;
    }
}

function draw(page: string) {
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

beforeEach(() => {
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
    cleanup();
    setNative(false);
    document.documentElement.classList.remove('rw-native');
});

describe('iOS アプリのタブ', () => {
    it('ブラウザでは出さず、/settings/ios は最初のページになる。ネイティブのコードも読み込まない', async () => {
        draw('ios');
        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(SETTINGS_PAGES.length);
        expect(screen.queryByRole('tab', { name: 'iOS アプリ' })).toBeNull();
        expect(screen.getByRole('tab', { name: 'モデル' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.queryByText('録音開始')).toBeNull();
        // dynamic import が走る余地を与えてから数える
        await new Promise((r) => setTimeout(r, 0));
        expect(loaded.bridge).toBe(0);
        expect(loaded.core).toBe(0);
    });

    it('startNativeShell はブラウザでは何もしない', async () => {
        const { startNativeShell } = await import('@/features/native/nativePlatform');
        startNativeShell();
        await new Promise((r) => setTimeout(r, 0));
        expect(document.documentElement.classList.contains('rw-native')).toBe(false);
        expect(loaded.bridge).toBe(0);
    });

    it('アプリの中では最後に「iOS アプリ」を足し、開くと録音の操作を出す', async () => {
        setNative(true);
        draw('ios');
        const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
        expect(tabs.at(-2)).toBe('セットアップ');
        expect(tabs.at(-1)).toBe('iOS アプリ');
        expect(screen.getByRole('tab', { name: 'iOS アプリ' }).getAttribute('aria-selected')).toBe('true');
        await waitFor(() => expect(screen.getByRole('button', { name: /録音開始/ })).toBeTruthy());
        expect(loaded.bridge).toBe(1);
    });

    it('アプリの中では startNativeShell が <html> に rw-native を付け、ネイティブの側を始める', async () => {
        setNative(true);
        const { startNativeShell } = await import('@/features/native/nativePlatform');
        startNativeShell();
        expect(document.documentElement.classList.contains('rw-native')).toBe(true);
        await waitFor(() => expect(startShell).toHaveBeenCalledTimes(1));
    });
});
