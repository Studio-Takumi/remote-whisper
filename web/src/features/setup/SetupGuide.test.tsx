// セットアップの案内（#291）の表示と、ボタンを押したときの呼び出し。部品を分けても同じに出ることを確かめる（#381）
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { api } from '@/api/api';
import { SetupGuide } from '@/features/setup/SetupGuide';
import type { SetupStatus } from '@/features/setup/setup';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

type Patch = Omit<Partial<SetupStatus>, 'llm' | 'whisperx'> & {
    llm?: Partial<SetupStatus['llm']>;
    whisperx?: Partial<SetupStatus['whisperx']>;
};

function status(patch: Patch = {}): SetupStatus {
    const { llm, whisperx, ...rest } = patch;
    return {
        runtime: 'windows-bundle',
        remote: false,
        recording: false,
        gpu: 'nvidia',
        hfToken: { source: null },
        ...rest,
        llm: {
            backend: 'ollama',
            running: true,
            found: true,
            unauthorized: false,
            downloadUrl: 'https://ollama.com/download',
            models: [
                { name: 'gemma4:e4b', sizeGb: 9.6, installed: true },
                { name: 'qwen3.5:2b', sizeGb: 2.7, installed: false },
            ],
            pull: null,
            pullCancellable: true,
            ...llm,
        },
        whisperx: {
            installed: false,
            installable: true,
            downloadGb: 3,
            diskGb: 6,
            minutes: [5, 15],
            command: null,
            install: null,
            ...whisperx,
        },
    };
}

const settings = { whisper: { finalTranscript: true, diarize: true } };

function draw(s: SetupStatus, onStatus = vi.fn(), onRefresh = vi.fn(async () => {})) {
    render(<SetupGuide status={s} onStatus={onStatus} onRefresh={onRefresh} settings={settings} />);
    return { onStatus, onRefresh };
}

function section(title: string): HTMLElement {
    const heading = screen.getByRole('heading', { name: title });
    return heading.closest('section') as HTMLElement;
}

describe('SetupGuide', () => {
    it('ホストで開いたときは飛ばせることを、クラウド版からは見るだけであることを出す', () => {
        draw(status());
        expect(screen.getByText(/どれも飛ばせます/)).toBeTruthy();
        cleanup();
        draw(status({ remote: true }));
        expect(screen.getByText(/クラウド版からは見るだけです/)).toBeTruthy();
        expect((screen.getByRole('button', { name: /取得/ }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('GPU がないときだけ GPU の手順を出す', () => {
        draw(status());
        expect(screen.queryByRole('heading', { name: 'GPU' })).toBeNull();
        cleanup();
        draw(status({ gpu: 'none' }));
        expect(section('GPU').textContent).toContain('CPU で動きます');
    });

    it('要約に使うアプリの状態を出し分ける', () => {
        draw(status());
        expect(section('Ollama').textContent).toContain('動いています');
        expect(screen.getAllByLabelText('そろっています').length).toBeGreaterThan(0);
        cleanup();
        draw(status({ llm: { running: false } }));
        expect(section('Ollama').textContent).toContain('Ollama が起動していません');
        cleanup();
        draw(status({ llm: { backend: 'lmstudio', running: false } }));
        expect(section('LM Studio').textContent).toContain('lms server start');
        cleanup();
        draw(status({ llm: { backend: 'lmstudio', running: false, unauthorized: true } }));
        expect(section('LM Studio').textContent).toContain('トークンが違うため');
        cleanup();
        draw(status({ llm: { running: false, found: false } }));
        const link = screen.getByRole('link', { name: /ダウンロードのページを開く/ });
        expect(link.getAttribute('href')).toBe('https://ollama.com/download');
    });

    it('もう一度確かめると onRefresh を呼ぶ', async () => {
        const { onRefresh } = draw(status({ llm: { running: false } }));
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: /もう一度確かめる/ }));
        });
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('要約のモデルの一覧と、足りないものを取るボタンを出す', async () => {
        const next = status();
        const post = vi.spyOn(api, 'post').mockResolvedValue(next);
        const { onStatus } = draw(status());
        const models = section('要約のモデル');
        expect(models.textContent).toContain('gemma4:e4b');
        expect(models.textContent).toContain('9.6 GB');
        expect(models.textContent).toContain('入っていません');
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '取得（約 2.7 GB）' }));
        });
        expect(post).toHaveBeenCalledWith('/api/setup/llm/pull', { models: ['qwen3.5:2b'] });
        expect(onStatus).toHaveBeenCalledWith(next);
    });

    it('大きさが分からないモデルがあれば「以上」を付け、録音中は押せない理由を出す', () => {
        draw(
            status({
                recording: true,
                llm: {
                    models: [
                        { name: 'a', sizeGb: 1.5, installed: false },
                        { name: 'b', sizeGb: null, installed: false },
                    ],
                },
            }),
        );
        const button = screen.getByRole('button', { name: '取得（約 1.5 GB 以上）' }) as HTMLButtonElement;
        expect(button.disabled).toBe(true);
        expect(screen.getByText('録音が終わってから取得できます')).toBeTruthy();
    });

    it('取っている途中は進み具合と、やめるボタン（LM Studio は案内）を出す', async () => {
        const pull = {
            state: 'running' as const,
            backend: 'ollama' as const,
            models: ['qwen3.5:2b'],
            model: 'qwen3.5:2b',
            index: 0,
            completed: 1_000_000_000,
            total: 2_000_000_000,
            error: null,
        };
        const del = vi.spyOn(api, 'delete').mockResolvedValue(status());
        draw(status({ llm: { pull } }));
        expect(screen.getByRole('progressbar', { name: 'qwen3.5:2b の取得' }).getAttribute('aria-valuenow')).toBe('50');
        expect(screen.getByText(/qwen3.5:2b を取得中（1\/1）・50%/)).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'やめる' }));
        });
        expect(del).toHaveBeenCalledWith('/api/setup/llm/pull');
        cleanup();
        draw(status({ llm: { backend: 'lmstudio', pull: { ...pull, backend: 'lmstudio' } } }));
        expect(screen.getByText('止めるときは LM Studio の画面から止めてください')).toBeTruthy();
    });

    it('取得に失敗した・やめたことを出す', () => {
        const pull = {
            backend: 'ollama' as const,
            models: ['x'],
            model: 'x',
            index: 0,
            completed: 0,
            total: 0,
        };
        draw(status({ llm: { pull: { ...pull, state: 'failed', error: 'ディスクが足りません' } } }));
        expect(screen.getByText('ディスクが足りません')).toBeTruthy();
        cleanup();
        draw(status({ llm: { pull: { ...pull, state: 'cancelled', error: null } } }));
        expect(screen.getByText('取得をやめました')).toBeTruthy();
    });

    it('WhisperX の状態を出し分ける', async () => {
        const post = vi.spyOn(api, 'post').mockResolvedValue(status());
        draw(status());
        expect(section('WhisperX').textContent).toContain(
            '約 3 GB をダウンロードし、ディスクを約 6 GB 使います。5〜15 分',
        );
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '入れる' }));
        });
        expect(post).toHaveBeenCalledWith('/api/setup/whisperx');
        cleanup();
        draw(status({ whisperx: { installed: true } }));
        expect(section('WhisperX').textContent).toContain('入っています');
        cleanup();
        draw(
            status({
                whisperx: {
                    install: {
                        state: 'running',
                        phase: 'installing',
                        package: 'torch',
                        collected: 0,
                        rolledBack: false,
                        rollbackFailed: false,
                        elapsedSec: 65,
                    },
                },
            }),
        );
        expect(section('WhisperX').textContent).toContain('：torch');
        expect(screen.getByRole('button', { name: 'やめる' })).toBeTruthy();
        cleanup();
        draw(status({ runtime: 'dev', whisperx: { installable: false, command: 'uv sync --extra final' } }));
        expect(screen.getByText('uv sync --extra final')).toBeTruthy();
        cleanup();
        draw(status({ whisperx: { installable: false } }));
        expect(screen.getByText(/この版では画面から入れられません/)).toBeTruthy();
    });

    it('WhisperX を入れられなかったことを、元に戻せたかで出し分ける', () => {
        const install = {
            state: 'failed' as const,
            phase: 'installing' as const,
            package: null,
            collected: 0,
            rolledBack: true,
            rollbackFailed: false,
            elapsedSec: 0,
        };
        draw(status({ whisperx: { install } }));
        expect(screen.getByText(/入れられなかったため、元に戻しました/)).toBeTruthy();
        cleanup();
        draw(status({ whisperx: { install: { ...install, rollbackFailed: true } } }));
        expect(screen.getByText(/元にも戻せませんでした/)).toBeTruthy();
    });

    it('トークンを保存すると入力欄を空にして送る。保存済みなら削除できる', async () => {
        const put = vi.spyOn(api, 'put').mockResolvedValue(status());
        draw(status());
        const input = screen.getByLabelText('HuggingFace のトークン') as HTMLInputElement;
        fireEvent.change(input, { target: { value: ' hf_abc ' } });
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '保存' }));
        });
        expect(put).toHaveBeenCalledWith('/api/setup/hf-token', { token: 'hf_abc' });
        expect(input.value).toBe('');
        cleanup();
        const del = vi.spyOn(api, 'delete').mockResolvedValue(status());
        draw(status({ hfToken: { source: 'file' } }));
        expect(screen.getByText('保存済み')).toBeTruthy();
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '削除' }));
        });
        expect(del).toHaveBeenCalledWith('/api/setup/hf-token');
        cleanup();
        draw(status({ hfToken: { source: 'env' } }));
        expect(screen.getByText('環境変数 HF_TOKEN のトークンを使っています')).toBeTruthy();
    });

    it('呼び出しに失敗したら状態を取り直す', async () => {
        vi.spyOn(api, 'post').mockRejectedValue(new Error('だめでした'));
        const { onStatus, onRefresh } = draw(status());
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: '入れる' }));
        });
        expect(onStatus).not.toHaveBeenCalled();
        expect(onRefresh).toHaveBeenCalled();
    });
});
