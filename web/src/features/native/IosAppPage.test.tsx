// 「iOS アプリ」ページの録音の操作（#438）。プラグインを偽物にして、開始・停止・イベントの表示・一覧・
// 録ったファイルを「音声ファイルから作る」に渡すところを確かめる
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Project } from '@/api/types';
import { useAppStore } from '@/app/store';
import { IosRecorderPanel } from '@/features/native/IosAppPage';
import type { ProgressEvent, RecorderPlugin, RecordingFile, StateChangeEvent } from '@/features/native/recorderTypes';

const project = vi.hoisted(() => ({ current: undefined as Project | undefined }));
vi.mock('@/app/sessionHooks', () => ({ useCurrentProject: () => project.current }));

const FILE: RecordingFile = {
    name: 'recording-20261119-120000.wav',
    durationSec: 65,
    size: 2 * 1024 * 1024,
    createdAt: '2026-11-19T12:00:00+09:00',
    modifiedAt: '2026-11-19T12:01:05+09:00',
};

// 録音のプラグインの偽物。emit でイベントを流す
function fakeRecorder(files: RecordingFile[] = []) {
    const listeners: Record<string, ((e: unknown) => void)[]> = {};
    const removed: string[] = [];
    const plugin = {
        start: vi.fn(async () => ({ file: 'recording-20261119-130000.wav' })),
        stop: vi.fn(async () => ({ file: FILE })),
        getStatus: vi.fn(async () => ({ state: 'idle', seconds: 0 })),
        listRecordings: vi.fn(async () => ({ files })),
        readRecording: vi.fn(async ({ offset = 0 }: { offset?: number }) => ({
            data: offset === 0 ? btoa('RIFF') : '',
            offset,
            size: 4,
        })),
        deleteRecording: vi.fn(async () => {}),
        addListener: vi.fn(async (name: string, fn: (e: unknown) => void) => {
            (listeners[name] ??= []).push(fn);
            return {
                remove: async () => {
                    removed.push(name);
                    listeners[name] = listeners[name].filter((f) => f !== fn);
                },
            };
        }),
    };
    const emit = (name: 'stateChange' | 'progress', e: StateChangeEvent | ProgressEvent) =>
        act(() => listeners[name]?.forEach((fn) => fn(e)));
    return { plugin, asPlugin: plugin as unknown as RecorderPlugin, emit, removed, listeners };
}

const uploadAudio = vi.fn(async () => {});

beforeEach(() => {
    project.current = { id: 'p1', name: '講義', path: '/data/lecture' } as Project;
    useAppStore.setState({ uploadAudio, uploading: null });
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('IosRecorderPanel', () => {
    it('開始・停止を呼び、状態と経過時間を出す', async () => {
        const { plugin, asPlugin, emit } = fakeRecorder();
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(plugin.listRecordings).toHaveBeenCalled());
        expect(screen.getByTestId('recorder-state').textContent).toBe('停止中');
        expect(screen.getByRole('button', { name: /録音停止/ })).toHaveProperty('disabled', true);

        fireEvent.click(screen.getByRole('button', { name: /録音開始/ }));
        await waitFor(() => expect(screen.getByTestId('recorder-state').textContent).toBe('録音中'));
        expect(plugin.start).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('button', { name: /録音開始/ })).toHaveProperty('disabled', true);

        emit('progress', { seconds: 75 });
        expect(screen.getByTestId('recorder-seconds').textContent).toBe('01:15');

        fireEvent.click(screen.getByRole('button', { name: /録音停止/ }));
        await waitFor(() => expect(screen.getByTestId('recorder-state').textContent).toBe('停止中'));
        expect(plugin.stop).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('recorder-reason').textContent).toBe('操作');
    });

    it('stateChange で割り込み中と理由を出し、止まったら一覧を取り直す', async () => {
        const { plugin, asPlugin, emit } = fakeRecorder();
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(plugin.addListener).toHaveBeenCalledTimes(2));

        emit('stateChange', { state: 'interrupted', reason: 'interruption' });
        expect(screen.getByTestId('recorder-state').textContent).toBe('割り込み中');
        expect(screen.getByTestId('recorder-reason').textContent).toBe('割り込み（電話・Siri など）');
        // 割り込み中も止められる
        expect(screen.getByRole('button', { name: /録音停止/ })).toHaveProperty('disabled', false);

        const calls = plugin.listRecordings.mock.calls.length;
        emit('stateChange', { state: 'idle', reason: 'interruptionEnded', file: FILE });
        expect(screen.getByTestId('recorder-state').textContent).toBe('停止中');
        expect(screen.getByTestId('recorder-reason').textContent).toBe('割り込みのあとに再開できず停止');
        await waitFor(() => expect(plugin.listRecordings.mock.calls.length).toBe(calls + 1));
    });

    it('外すとイベントの購読を解除する', async () => {
        const { plugin, asPlugin, removed } = fakeRecorder();
        const { unmount } = render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(plugin.addListener).toHaveBeenCalledTimes(2));
        unmount();
        await waitFor(() => expect(removed.sort()).toEqual(['progress', 'stateChange']));
    });

    it('マイクがないと no-input の文言を出す', async () => {
        const { plugin, asPlugin } = fakeRecorder();
        plugin.start.mockRejectedValueOnce(Object.assign(new Error('no input'), { code: 'no-input' }));
        render(<IosRecorderPanel plugin={asPlugin} />);
        fireEvent.click(screen.getByRole('button', { name: /録音開始/ }));
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('マイクが見つかりません'));
    });

    it('録ったファイルの一覧を出し、選んだファイルを今開いているプロジェクトのアップロードに渡す', async () => {
        const { plugin, asPlugin } = fakeRecorder([FILE]);
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(screen.getAllByTestId('recording-file')).toHaveLength(1));
        expect(screen.getByText(FILE.name)).toBeTruthy();
        expect(screen.getByTestId('recording-file').textContent).toContain('01:05 ・ 2.0MB');
        expect(screen.getByText('講義 にセッションを作ります')).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /セッションを作る/ }));
        await waitFor(() => expect(uploadAudio).toHaveBeenCalledTimes(1));
        const [projectId, file] = uploadAudio.mock.calls[0] as unknown as [string, File];
        expect(projectId).toBe('p1');
        expect(file.name).toBe(FILE.name);
        expect(file.type).toBe('audio/wav');
        expect(file.lastModified).toBe(Date.parse(FILE.modifiedAt));
        expect(await file.text()).toBe('RIFF');
        expect(plugin.readRecording).toHaveBeenCalled();
    });

    it('プロジェクトを開いていなければ、セッションを作れない', async () => {
        project.current = undefined;
        const { asPlugin } = fakeRecorder([FILE]);
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(screen.getAllByTestId('recording-file')).toHaveLength(1));
        expect(screen.getByRole('button', { name: /セッションを作る/ })).toHaveProperty('disabled', true);
        expect(screen.getByText('プロジェクトを開くとセッションを作れます')).toBeTruthy();
    });

    it('削除はダイアログで確かめてから deleteRecording を呼ぶ。キャンセルなら呼ばない', async () => {
        const { plugin, asPlugin } = fakeRecorder([FILE]);
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(screen.getAllByTestId('recording-file')).toHaveLength(1));

        fireEvent.click(screen.getByRole('button', { name: `${FILE.name} を削除` }));
        const dialog = await screen.findByRole('dialog');
        expect(dialog.textContent).toContain(FILE.name);
        fireEvent.click(within(dialog).getByRole('button', { name: 'キャンセル' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(plugin.deleteRecording).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: `${FILE.name} を削除` }));
        fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: /削除/ }));
        await waitFor(() => expect(plugin.deleteRecording).toHaveBeenCalledWith({ name: FILE.name }));
    });

    it('イベントを購読できなくても、未処理の reject にせず文言を出す', async () => {
        const { plugin, asPlugin } = fakeRecorder();
        plugin.addListener.mockRejectedValue(Object.assign(new Error('not implemented'), { code: 'UNIMPLEMENTED' }));
        // 未処理の reject があれば vitest が失敗にする（購読のときと、外すときの両方）
        const { unmount } = render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('失敗しました（UNIMPLEMENTED）'));
        unmount();
        await new Promise((r) => setTimeout(r, 10));
    });

    it('録音中のファイルは、作る・削除を押せない', async () => {
        const { plugin, asPlugin } = fakeRecorder([{ ...FILE, name: 'recording-20261119-130000.wav' }]);
        plugin.getStatus.mockResolvedValueOnce({
            state: 'recording',
            file: 'recording-20261119-130000.wav',
            seconds: 3,
        } as never);
        render(<IosRecorderPanel plugin={asPlugin} />);
        await waitFor(() => expect(screen.getByTestId('recorder-state').textContent).toBe('録音中'));
        await waitFor(() => expect(screen.getAllByTestId('recording-file')).toHaveLength(1));
        expect(screen.getByRole('button', { name: /セッションを作る/ })).toHaveProperty('disabled', true);
        expect(screen.getByRole('button', { name: /を削除/ })).toHaveProperty('disabled', true);
    });
});
