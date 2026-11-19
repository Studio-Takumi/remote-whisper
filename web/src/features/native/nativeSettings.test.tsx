// iOS アプリの中でだけ出す「iOS アプリ」タブ（#438。spec/mobile.md 11.4）。ブラウザでは出さず、
// ネイティブを呼ぶコード（nativeBridge・@capacitor/core）も読み込まないこと
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsOptions } from '@/api/protocol';
import type { RecorderPlugin } from '@/features/native/recorderTypes';
import { SETTINGS_PAGES, defaultSettings } from '@/features/settings/settings';

// 読み込まれたかを数える（vi.mock の中から触るので vi.hoisted にする）。
// テストごとに vi.resetModules() で読み込み直すので、並び順に依存しない
const loaded = vi.hoisted(() => ({ bridge: 0, core: 0 }));

// 録音のプラグインの偽物。本物（Capacitor の Proxy）と同じく、then を聞かれたらメソッドとして返し、
// その Promise は決して解決しない。Promise の結果にそのまま渡すと await が止まる
const fakeRecorder = vi.hoisted(() => {
    const methods: Record<string, unknown> = {
        start: async () => ({ file: 'recording-20261119-120000.wav' }),
        stop: async () => ({ file: {} }),
        getStatus: async () => ({ state: 'idle', seconds: 0 }),
        listRecordings: async () => ({ files: [] }),
        readRecording: async () => ({ data: '', offset: 0, size: 0 }),
        deleteRecording: async () => {},
        addListener: async () => ({ remove: async () => {} }),
    };
    return new Proxy(
        {},
        { get: (_, prop) => (prop === 'then' ? () => new Promise(() => {}) : methods[prop as string]) },
    ) as RecorderPlugin;
});

const startShell = vi.hoisted(() => vi.fn());

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

describe('iOS アプリのタブ', () => {
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
        expect(screen.queryByRole('tab', { name: 'iOS アプリ' })).toBeNull();
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

    it('アプリの中では最後に「iOS アプリ」を足し、開くと録音の操作を出す。保存・キャンセルは出さない', async () => {
        setNative();
        await draw('ios');
        const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
        expect(tabs.at(-2)).toBe('セットアップ');
        expect(tabs.at(-1)).toBe('iOS アプリ');
        expect(screen.getByRole('tab', { name: 'iOS アプリ' }).getAttribute('aria-selected')).toBe('true');
        await waitFor(() => expect(screen.getByRole('button', { name: /録音開始/ })).toBeTruthy());
        expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'キャンセル' })).toBeNull();
        expect(loaded.bridge).toBe(1);
    });

    it('アプリの中でも、ほかのタブでは保存・キャンセルを出す', async () => {
        setNative();
        await draw('models');
        expect(screen.getByRole('tab', { name: 'iOS アプリ' })).toBeTruthy();
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

    it('loadRecorder はプラグイン（then を持つ Proxy）を { plugin } に包んで返す', async () => {
        const { loadRecorder } = await import('@/features/native/nativePlatform');
        const result = await Promise.race([
            loadRecorder(),
            new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 500)),
        ]);
        expect(result).not.toBe('timeout');
        expect((result as { plugin: RecorderPlugin }).plugin).toBe(fakeRecorder);
    });
});
