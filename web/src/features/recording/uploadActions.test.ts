// 音声ファイルから作るときの、文字起こしの言語（#482）
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActionContext } from '@/app/actionContext';
import type { AppState } from '@/app/appState';
import { uploadAudio as sendAudio } from '@/features/recording/upload';
import { uploadAudio, uploadSeparately } from '@/features/recording/uploadActions';
import { defaultSettings } from '@/features/settings/settings';

vi.mock('@/features/recording/upload', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/features/recording/upload')>()),
    uploadAudio: vi.fn(async (_projectId: string, file: File) => ({ id: `s-${file.name}` })),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

afterEach(() => {
    vi.clearAllMocks();
});

// ストアの代わり。セッションを開くと新規セッション画面を離れるので、今回だけの言語は消える
function context(state: Partial<AppState>) {
    const s = {
        uploading: null,
        generating: null,
        settings: defaultSettings,
        loadProjects: async () => {},
        selectSession: () => Object.assign(s, { nextLanguage: null }),
        ...state,
    } as AppState;
    const ctx = {
        store: {
            getState: () => s,
            setState: (patch: Partial<AppState> | ((x: AppState) => Partial<AppState>)) =>
                Object.assign(s, typeof patch === 'function' ? patch(s) : patch),
            subscribe: () => () => {},
        },
        recorder: { metrics: { awaitUpload: vi.fn() } },
    } as unknown as ActionContext;
    s.uploadAudio = (projectId, file, language) => uploadAudio(ctx, projectId, file, language);
    return ctx;
}

function file(name: string) {
    return new File(['x'], name, { lastModified: 1 });
}

describe('音声ファイルの文字起こしの言語', () => {
    it('新規セッション画面で選んだ言語を付けて送る', async () => {
        const ctx = context({ nextLanguage: 'auto' });
        await uploadAudio(ctx, 'p', file('a.mp3'));
        expect(vi.mocked(sendAudio).mock.calls[0][4]).toBe('auto');
    });

    it('別々に送るときは、2 つ目以降のファイルにも同じ言語を付ける', async () => {
        const ctx = context({
            nextLanguage: 'auto',
            pickedAudio: { projectId: 'p', files: [file('a.mp3'), file('b.mp3')] },
        });
        await uploadSeparately(ctx);
        expect(vi.mocked(sendAudio).mock.calls.map((c) => [c[1].name, c[4]])).toEqual([
            ['a.mp3', 'auto'],
            ['b.mp3', 'auto'],
        ]);
    });
});
