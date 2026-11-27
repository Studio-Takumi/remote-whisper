// 音声ファイルから新しいセッションを作る（#180）。複数なら別々にするか、1 つのセッションの音源にまとめる（#357）
import { toast } from 'sonner';

import { isDemo } from '@/api/demo';
import type { ActionContext } from '@/app/actionContext';
import { recordingMessages } from '@/features/recording/i18n';
import { UploadError, uploadAudio as sendAudio, uploadSource } from '@/features/recording/upload';
import { type TranscriptionLanguage, finalModelLabel, llmModels } from '@/features/settings/settings';

// 音声ファイルから作ったセッションを開く。最終の文字起こしと最終の要約は、サーバーが後ろで作る
async function openUploaded(ctx: ActionContext, projectId: string, sessionId: string) {
    const { getState: get, setState: set } = ctx.store;
    ctx.recorder.metrics.awaitUpload(sessionId, get().settings);
    await get().loadProjects();
    get().selectSession(projectId, sessionId);
    // 要約が届くまでは「作成中」と出す（作り終えたら、status の summarizing から外れたことで取り直す）
    if (!get().generating) {
        set((s) => ({ generating: { sessionId, model: finalModelLabel(llmModels(s.settings)), text: '' } }));
    }
}

// language は今回だけ変えた文字起こしの言語（#482）。省くと新規セッション画面で選んでいるもの
export async function uploadAudio(
    ctx: ActionContext,
    projectId: string,
    file: File,
    language: TranscriptionLanguage | null = ctx.store.getState().nextLanguage,
) {
    const { getState: get, setState: set } = ctx.store;
    if (isDemo) {
        toast.info(recordingMessages.t('uploadActions.demo'));
        return;
    }
    if (get().uploading) {
        toast.info(recordingMessages.t('uploadActions.busy'));
        return;
    }
    set({ uploading: { projectId, name: file.name, percent: 0 } });
    try {
        const created = await sendAudio(
            projectId,
            file,
            (percent) => set({ uploading: { projectId, name: file.name, percent } }),
            undefined,
            language,
        );
        await openUploaded(ctx, projectId, created.id);
        toast.success(recordingMessages.t('uploadActions.created', { name: file.name }));
    } catch (e) {
        toast.error(recordingMessages.t('uploadActions.failed', { name: file.name, message: (e as Error).message }));
    } finally {
        set({ uploading: null });
    }
}

export function pickAudioFiles(ctx: ActionContext, projectId: string, files: File[]) {
    const { getState: get, setState: set } = ctx.store;
    if (files.length === 1) {
        void get().uploadAudio(projectId, files[0]);
    } else if (files.length > 1) {
        if (get().uploading) {
            toast.info(recordingMessages.t('uploadActions.busy'));
            return;
        }
        set({ pickedAudio: { projectId, files } });
    }
}

export async function uploadSeparately(ctx: ActionContext) {
    const { getState: get, setState: set } = ctx.store;
    const picked = get().pickedAudio;
    set({ pickedAudio: null });
    if (!picked) {
        return;
    }
    // 1 つずつ送る（同時に送れるのは 1 つだけ）。最後に作ったセッションが開く。
    // 1 つ目を開くと新規セッション画面を離れるので、選んでいた言語は先に取っておく
    const language = get().nextLanguage;
    for (const file of picked.files) {
        await get().uploadAudio(picked.projectId, file, language);
    }
}

// まとめて送った結果を知らせる。failed は送れなかったファイル、old は 404（まとめられない古いホスト）
function reportSources(files: File[], failed: string[], old: boolean) {
    const total = files.length;
    if (old) {
        // 1 つ目のファイルだけのセッションとして浄書が始まっている
        toast.warning(recordingMessages.t('uploadActions.oldHost', { name: files[0].name }), {
            duration: 15000,
        });
    } else if (failed.length > 0) {
        // ホストは残りのファイルを 30 分待ってから、届いた分だけで作る（spec/flows.md 6.16）
        toast.error(
            recordingMessages.t('uploadActions.partialFailed', {
                failed: failed.join(recordingMessages.t('uploadActions.separator')),
                n: total - failed.length,
            }),
            { duration: 20000 },
        );
    } else {
        toast.success(recordingMessages.t('uploadActions.merged', { total }));
    }
}

export async function uploadSources(ctx: ActionContext, main: number) {
    const { getState: get, setState: set } = ctx.store;
    const picked = get().pickedAudio;
    set({ pickedAudio: null });
    if (!picked || isDemo || get().uploading) {
        return;
    }
    const { projectId } = picked;
    // 主の音源にするファイルを先頭にする
    const files = [picked.files[main], ...picked.files.filter((_, i) => i !== main)];
    const total = files.length;
    const progress = (i: number, percent: number) =>
        set({
            uploading: {
                projectId,
                name: recordingMessages.t('uploadActions.progressName', { name: files[i].name, i: i + 1, total }),
                percent,
            },
        });
    progress(0, 0);
    try {
        const created = await sendAudio(projectId, files[0], (p) => progress(0, p), total, get().nextLanguage);
        // 送れなかったファイル。old は 404（まとめられない古いホスト）
        const failed: string[] = [];
        let old = false;
        for (let i = 1; i < total; i++) {
            try {
                await uploadSource(projectId, created.id, files[i], (p) => progress(i, p));
            } catch (e) {
                if (e instanceof UploadError && e.status === 404) {
                    old = true;
                    break;
                }
                failed.push(
                    recordingMessages.t('uploadActions.failedItem', {
                        name: files[i].name,
                        message: (e as Error).message,
                    }),
                );
            }
        }
        await openUploaded(ctx, projectId, created.id);
        reportSources(files, failed, old);
    } catch (e) {
        toast.error(
            recordingMessages.t('uploadActions.failed', { name: files[0].name, message: (e as Error).message }),
        );
    } finally {
        set({ uploading: null });
    }
}
