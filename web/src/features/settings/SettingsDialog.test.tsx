// 設定のモーダルの各ページの項目と、保存したときに送る中身。部品を分けても同じに動くことを確かめる（#381）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/api';
import type { SettingsOptions } from '@/api/protocol';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { type Settings, defaultSettings } from '@/features/settings/settings';
import { setLanguage } from '@/i18n/language';

const options: SettingsOptions = {
    whisper: { models: ['large-v3-turbo'], computeTypes: ['float16', 'int8'] },
    llm: { backend: 'ollama', models: [{ name: 'gemma4:e4b', thinking: true }] },
};

beforeEach(() => {
    // jsdom には matchMedia がない（useIsMobile が使う）
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

function draw(
    page: string,
    {
        settings = defaultSettings,
        loaded = true,
        recording = false,
    }: { settings?: Settings; loaded?: boolean; recording?: boolean } = {},
) {
    const props = {
        onOpenChange: vi.fn(),
        onPageChange: vi.fn(),
        onRetry: vi.fn(),
        onSave: vi.fn(),
    };
    render(
        <SettingsDialog
            open
            page={page}
            settings={settings}
            loaded={loaded}
            options={options}
            recording={recording}
            {...props}
        />,
    );
    return props;
}

function input(label: string) {
    return screen.getByLabelText(label) as HTMLInputElement;
}

describe('SettingsDialog', () => {
    it('読み込めていなければフォームを出さず、再読み込みを促す', () => {
        const { onRetry } = draw('whisper', { loaded: false });
        expect(screen.getByText('設定を読み込めていません')).toBeTruthy();
        expect(screen.queryByRole('button', { name: '保存' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: '再読み込み' }));
        expect(onRetry).toHaveBeenCalled();
    });

    it('カテゴリを並べ、選ぶと onPageChange を呼ぶ。知らないページは最初のページ', () => {
        const { onPageChange } = draw('unknown');
        const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
        expect(tabs).toEqual([
            'モデル',
            '参考資料',
            '録音',
            '文字起こし',
            '要約',
            '保存',
            '表示・その他',
            'セットアップ',
        ]);
        expect(screen.getByRole('tab', { name: 'モデル' }).getAttribute('aria-selected')).toBe('true');
        fireEvent.mouseDown(screen.getByRole('tab', { name: '録音' }), { button: 0 });
        expect(onPageChange).toHaveBeenCalledWith('recording');
    });

    it('文字起こしのページの項目', () => {
        draw('whisper');
        for (const label of [
            '計算の精度',
            'ビームサイズ',
            '途中結果の間隔',
            '区切りとみなす無音',
            'チャンクの最大の長さ',
            '話し声の判定',
            '浄書',
            '話者分け',
            '録音終了後にモデルを停止するまでの時間',
        ]) {
            expect(screen.getByText(label)).toBeTruthy();
        }
        expect(input('ビームサイズ').value).toBe('5');
        // 手動のときだけ音量を出す
        expect(screen.queryByText('手動のときの音量')).toBeNull();
        cleanup();
        draw('whisper', {
            settings: { ...defaultSettings, whisper: { ...defaultSettings.whisper, speechThreshold: 'manual' } },
        });
        expect(input('手動のときの音量').value).toBe('-40');
    });

    it('文字起こしの言語は、古いサーバー（whisper.language がない）では出さない（#482）', () => {
        draw('whisper');
        expect(screen.getByLabelText('文字起こしの言語').textContent).toContain('日本語');
        cleanup();
        // 未設定（#498）は、表示言語が日本語以外なら自動判定で出す。選んだ値はそのまま
        setLanguage('en');
        try {
            draw('whisper');
            expect(screen.getByLabelText('文字起こしの言語').textContent).toContain('自動判定');
            cleanup();
            draw('whisper', {
                settings: { ...defaultSettings, whisper: { ...defaultSettings.whisper, language: 'ja' } },
            });
            expect(screen.getByLabelText('文字起こしの言語').textContent).toContain('日本語');
            cleanup();
        } finally {
            setLanguage('ja');
        }
        const { language: _language, ...whisper } = defaultSettings.whisper;
        draw('whisper', { settings: { ...defaultSettings, whisper } });
        expect(screen.queryByText('文字起こしの言語')).toBeNull();
    });

    it('要約の言語は、古いサーバー（ollama.summaryLanguage がない）では出さない（#485）', () => {
        // 初期値は「表示言語に合わせる」（#498）
        draw('ollama');
        expect(screen.getByLabelText('要約の言語').textContent).toContain('表示言語に合わせる');
        cleanup();
        draw('ollama', {
            settings: { ...defaultSettings, ollama: { ...defaultSettings.ollama, summaryLanguage: 'ja' } },
        });
        expect(screen.getByLabelText('要約の言語').textContent).toContain('日本語');
        cleanup();
        draw('ollama', {
            settings: { ...defaultSettings, ollama: { ...defaultSettings.ollama, summaryLanguage: 'transcript' } },
        });
        expect(screen.getByLabelText('要約の言語').textContent).toContain('文字起こしと同じ');
        cleanup();
        const { summaryLanguage: _summaryLanguage, ...ollama } = defaultSettings.ollama;
        draw('ollama', { settings: { ...defaultSettings, ollama } });
        expect(screen.queryByText('要約の言語')).toBeNull();
    });

    it('要約のページの項目', () => {
        draw('ollama');
        for (const label of [
            '要約に使うアプリ',
            '要約の言語',
            'Ollama の URL',
            'リアルタイム要約',
            '全体概要',
            '要約詳細',
            '参考資料のページの表示',
            'リアルタイム要約の間隔',
            '録音中の用語抽出',
            '要約後にモデルを停止するまでの時間',
        ]) {
            expect(screen.getByText(label)).toBeTruthy();
        }
        expect(input('Ollama の URL').value).toBe('http://localhost:11434');
    });

    it('録音・保存・参考資料・表示のページの項目', () => {
        draw('recording');
        expect(input('同時に録音できる数').value).toBe('1');
        expect(screen.getByText('ブラウザのエコー除去')).toBeTruthy();
        cleanup();
        draw('storage');
        expect(screen.getByText('保存期間')).toBeTruthy();
        expect(screen.getByText('録音ファイル')).toBeTruthy();
        expect(screen.getByText('選んだディレクトリに置いたコピーは消しません')).toBeTruthy();
        cleanup();
        draw('materials');
        expect(screen.getByText('読み込めるフォルダ')).toBeTruthy();
        expect(screen.getByText('PDF の図を読む')).toBeTruthy();
        cleanup();
        draw('display');
        expect(screen.getByText('サイドバーの録音日時と長さ')).toBeTruthy();
        expect(screen.getByText('マイクボタンのショートカット')).toBeTruthy();
        expect(screen.getByText('この端末')).toBeTruthy();
        // 表示言語（#487）は端末ごとで、テーマの下
        expect(screen.getByText('表示言語')).toBeTruthy();
    });

    it('数の入力は単位を出し、変えた値を保存する', () => {
        const { onSave, onOpenChange } = draw('whisper');
        expect(screen.getByText('ミリ秒')).toBeTruthy();
        fireEvent.change(input('ビームサイズ'), { target: { value: '7' } });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect(onSave.mock.calls[0][0].whisper.beamSize).toBe(7);
        expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('保存するときに、フォルダ・拡張子・ホスト名の入力途中の空要素を落とす', () => {
        const settings: Settings = {
            ...defaultSettings,
            materials: { ...defaultSettings.materials, roots: ['D:\\a'], extensions: ['.pdf'] },
            network: { allowedHosts: [] },
        };
        const { onSave } = draw('materials', { settings });
        fireEvent.click(screen.getByRole('button', { name: /フォルダを追加/ }));
        fireEvent.change(input('拡張子'), { target: { value: 'pdf, , md ' } });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        const saved = onSave.mock.calls[0][0] as Settings;
        expect(saved.materials.roots).toEqual(['D:\\a']);
        expect(saved.materials.extensions).toEqual(['.pdf', '.md']);
        expect(saved.network).toEqual({ allowedHosts: [] });
    });

    it('フォルダを外せる', () => {
        const settings: Settings = {
            ...defaultSettings,
            materials: { ...defaultSettings.materials, roots: ['D:\\a', 'D:\\b'] },
        };
        const { onSave } = draw('materials', { settings });
        fireEvent.click(screen.getAllByRole('button', { name: 'このフォルダを外す' })[0]);
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect((onSave.mock.calls[0][0] as Settings).materials.roots).toEqual(['D:\\b']);
    });

    it('録音中は変えられない項目に理由を出し、変えても今の値で保存する', () => {
        const { onSave } = draw('whisper', { recording: true });
        expect(screen.getByText('全体設定（録音中は一部の項目は変更不可）')).toBeTruthy();
        expect(screen.getAllByText('録音中は変えられません').length).toBeGreaterThan(0);
        fireEvent.change(input('区切りとみなす無音'), { target: { value: '900' } });
        fireEvent.change(input('ビームサイズ'), { target: { value: '3' } });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        const saved = onSave.mock.calls[0][0] as Settings;
        expect(saved.whisper.silenceMs).toBe(600);
        expect(saved.whisper.beamSize).toBe(3);
    });

    it('ホスト名は古いサーバー（network がない）では出さない', () => {
        draw('display', { settings: { ...defaultSettings, network: undefined } });
        expect(screen.queryByText('許可するホスト名')).toBeNull();
        cleanup();
        const { onSave } = draw('display', { settings: { ...defaultSettings, network: { allowedHosts: [] } } });
        fireEvent.change(input('許可するホスト名'), { target: { value: 'a.example.com, ' } });
        fireEvent.click(screen.getByRole('button', { name: '保存' }));
        expect((onSave.mock.calls[0][0] as Settings).network).toEqual({ allowedHosts: ['a.example.com'] });
    });

    it('セットアップのページは状態を取ってから案内を出す', async () => {
        let resolve: (v: unknown) => void = () => {};
        vi.spyOn(api, 'get').mockReturnValue(new Promise((r) => (resolve = r)));
        draw('setup');
        expect(screen.getByText('確かめています…')).toBeTruthy();
        await act(async () => {
            resolve({
                runtime: 'dev',
                remote: false,
                recording: false,
                gpu: 'none',
                llm: {
                    backend: 'ollama',
                    running: true,
                    found: true,
                    unauthorized: false,
                    downloadUrl: '',
                    models: [],
                    pull: null,
                    pullCancellable: true,
                },
                whisperx: {
                    installed: true,
                    installable: true,
                    downloadGb: 1,
                    diskGb: 1,
                    minutes: [1, 2],
                    command: null,
                    install: null,
                },
                hfToken: { source: 'env' },
            });
        });
        expect(screen.getByRole('heading', { name: 'GPU' })).toBeTruthy();
    });
});
