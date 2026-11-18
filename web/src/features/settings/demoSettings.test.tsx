// デモ版（#415）の設定の画面: 表示の設定だけ変えられて端末に残り、ほかは止める。モデルのページは開けて、中の変更は止める
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsOptions } from '@/api/protocol';
import { demoRefusal } from '@/app/demoGuard';
import { useAppStore } from '@/app/store';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { DEMO_DISPLAY_KEY, editableInDemo, saveDisplay, withStoredDisplay } from '@/features/settings/demoDisplay';
import { defaultSettings, openablePages, settingsPageOf } from '@/features/settings/settings';

vi.mock('@/api/demoBuild', () => ({ isDemoBuild: true }));

const options: SettingsOptions = {
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16', 'int8'] },
    llm: { backend: 'ollama', models: [{ name: 'gemma4:e4b', thinking: true }] },
};

beforeEach(() => {
    localStorage.clear();
    vi.spyOn(toast, 'info');
    window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

function draw(page: string) {
    const props = { onOpenChange: vi.fn(), onPageChange: vi.fn(), onRetry: vi.fn(), onSave: vi.fn() };
    render(
        <SettingsDialog
            open
            page={page}
            settings={defaultSettings}
            loaded
            options={options}
            recording={false}
            {...props}
        />,
    );
    return props;
}

describe('デモ版の設定の画面', () => {
    it('表示の設定の 3 つだけが変えられる（マイクのショートカットは止める）', () => {
        expect(editableInDemo('display', { sessionMeta: true })).toBe(true);
        expect(editableInDemo('display', { showSpeakers: true, showPickedTerms: true })).toBe(true);
        expect(editableInDemo('display', { micShortcut: 'KeyM' })).toBe(false);
        expect(editableInDemo('recording', { noiseSuppression: false })).toBe(false);
    });

    it('表示の設定を変えて保存すると、その値が渡る', () => {
        const { onSave } = draw('display');
        fireEvent.click(screen.getByLabelText('サイドバーの録音日時と長さ'));
        fireEvent.click(screen.getByLabelText('話者の表示'));
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        const saved = onSave.mock.calls[0][0];
        expect(saved.display).toMatchObject({ sessionMeta: true, showSpeakers: true });
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('ほかの設定は、トーストで断って値を変えない', () => {
        const { onSave } = draw('recording');
        const before = (screen.getByLabelText('ブラウザのエコー除去') as HTMLInputElement).getAttribute('aria-checked');
        fireEvent.click(screen.getByLabelText('ブラウザのエコー除去'));
        expect(toast.info).toHaveBeenCalledWith(demoRefusal('settings'), expect.anything());
        expect(screen.getByLabelText('ブラウザのエコー除去').getAttribute('aria-checked')).toBe(before);
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect(onSave.mock.calls[0][0]).toEqual(defaultSettings);
    });

    it('入力欄に打っても、値は変わらない', () => {
        draw('recording');
        const field = screen.getByLabelText('同時に録音できる数') as HTMLInputElement;
        fireEvent.change(field, { target: { value: '3' } });
        expect(toast.info).toHaveBeenCalledWith(demoRefusal('settings'), expect.anything());
        expect(field.value).toBe('1');
    });

    it('マイクのショートカットは変えられない', () => {
        draw('display');
        fireEvent.click(screen.getByRole('button', { name: '使わない' }));
        expect(toast.info).toHaveBeenCalledWith(demoRefusal('settings'), expect.anything());
    });

    it('モデルのタブは開ける。セットアップのタブは出さない', () => {
        const { onPageChange } = draw('materials');
        expect(screen.queryByRole('tab', { name: 'セットアップ' })).toBeNull();
        fireEvent.mouseDown(screen.getByRole('tab', { name: 'モデル' }), { button: 0 });
        expect(onPageChange).toHaveBeenCalledWith('models');
        expect(toast.info).not.toHaveBeenCalled();
    });

    it('URL で /settings/models を開くとモデルのページが出て、/settings/setup は最初のページになる', () => {
        expect(openablePages()).toContain('models');
        expect(settingsPageOf('models')).toBe('models');
        expect(settingsPageOf('setup')).toBe('models');
        draw('models');
        expect(screen.getByText('処理ごとのモデルです', { exact: false })).toBeTruthy();
    });

    it('モデルのページの「おすすめに戻す」も断る', () => {
        const { onSave } = draw('models');
        fireEvent.click(screen.getByRole('button', { name: 'おすすめに戻す' }));
        expect(toast.info).toHaveBeenCalledWith(demoRefusal('settings'), expect.anything());
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect(onSave.mock.calls[0][0]).toEqual(defaultSettings);
    });
});

describe('表示の設定の保存（端末の中）', () => {
    it('保存した表示の設定は localStorage に残り、読み直したときに重なる', () => {
        const next = { ...defaultSettings, display: { ...defaultSettings.display, sessionMeta: true } };
        const saved = saveDisplay(defaultSettings, next);
        expect(saved.display.sessionMeta).toBe(true);
        expect(JSON.parse(localStorage.getItem(DEMO_DISPLAY_KEY) ?? '{}')).toMatchObject({ sessionMeta: true });
        expect(withStoredDisplay(defaultSettings).display.sessionMeta).toBe(true);
    });

    it('表示以外の項目と、マイクのショートカットは、渡されても保存しない', () => {
        const next = {
            ...defaultSettings,
            recording: { ...defaultSettings.recording, maxConcurrent: 5 },
            display: { ...defaultSettings.display, micShortcut: 'KeyZ', showSpeakers: true },
        };
        const saved = saveDisplay(defaultSettings, next);
        expect(saved.recording).toEqual(defaultSettings.recording);
        expect(saved.display.micShortcut).toBe(defaultSettings.display.micShortcut);
        expect(Object.keys(JSON.parse(localStorage.getItem(DEMO_DISPLAY_KEY) ?? '{}')).sort()).toEqual([
            'sessionMeta',
            'showPickedTerms',
            'showSpeakers',
        ]);
    });

    it('こわれた保存値は無視する', () => {
        localStorage.setItem(DEMO_DISPLAY_KEY, '{oops');
        expect(withStoredDisplay(defaultSettings)).toEqual(defaultSettings);
        localStorage.setItem(DEMO_DISPLAY_KEY, JSON.stringify({ sessionMeta: 'yes', micShortcut: 'KeyZ' }));
        expect(withStoredDisplay(defaultSettings)).toEqual(defaultSettings);
    });

    it('changeSettings は表示の設定だけを反映し、サーバーには送らない', async () => {
        const initial = useAppStore.getState().settings;
        const next = {
            ...initial,
            whisper: { ...initial.whisper, model: 'small' },
            display: { ...initial.display, showPickedTerms: true },
        };
        let ok = false;
        await act(async () => {
            ok = await useAppStore.getState().changeSettings(next);
        });
        expect(ok).toBe(true);
        const after = useAppStore.getState().settings;
        expect(after.display.showPickedTerms).toBe(true);
        expect(after.whisper.model).toBe(initial.whisper.model);
        useAppStore.setState({ settings: initial });
    });
});
