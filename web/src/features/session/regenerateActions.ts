// 最終の文字起こし（#124）と最終の要約を、今の全体設定で作り直す・出す世代を選ぶ
import { toast } from 'sonner';

import { ApiError, api } from '@/api/api';
import { isDemo } from '@/api/demo';
import { fetchFinalTranscript } from '@/api/transcripts';
import type { ActionContext } from '@/app/actionContext';
import { blockInDemo } from '@/app/demoGuard';
import { recordingLocks } from '@/features/recording/recording';
import { finalModelLabel, llmModels } from '@/features/settings/settings';

export async function regenerateFinalTranscript(ctx: ActionContext, sessionId: string) {
    const get = ctx.store.getState;
    if (blockInDemo('regenerateFinalTranscript')) {
        return;
    }
    if (isDemo) {
        toast.info('デモでは文字起こしを再生成できません');
        return;
    }
    if (get().recordingState !== 'idle') {
        toast.warning(recordingLocks.regenerate);
        return;
    }
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return;
    }
    // 返事より先に結果（失敗の error）が届くこともあるので、頼む前に覚えておく
    ctx.sessions.expectFinalTranscript(sessionId);
    try {
        // 結果は WebSocket（finalTranscript か error）で届く。作っている間は status の transcribing に入る
        await api.post(`/api/projects/${projectId}/sessions/${sessionId}/final-transcripts`);
    } catch (e) {
        ctx.sessions.forgetFinalTranscript(sessionId);
        if (e instanceof ApiError && e.status === 409) {
            toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');
        } else if (e instanceof ApiError && e.status === 410) {
            toast.error('録音ファイルが期限切れのため、再生成できません');
        } else {
            toast.error(`文字起こしを再生成できません: ${(e as Error).message}`);
        }
    }
}

export async function showFinalTranscript(ctx: ActionContext, sessionId: string, generationId: string) {
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return;
    }
    try {
        const finalTranscript = await fetchFinalTranscript(projectId, sessionId, generationId);
        ctx.sessions.patchSession(sessionId, (x) => ({ ...x, finalTranscript }));
    } catch (e) {
        toast.error(`文字起こしを読み込めません: ${(e as Error).message}`);
    }
}

export async function regenerateSummary(ctx: ActionContext, sessionId: string) {
    const { getState: get, setState: set } = ctx.store;
    if (blockInDemo('regenerateSummary')) {
        return;
    }
    if (isDemo) {
        toast.info('デモでは要約を再生成できません');
        return;
    }
    if (get().recordingState !== 'idle') {
        toast.warning(recordingLocks.regenerate);
        return;
    }
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return;
    }
    ctx.status.forgetFinishedSummary(sessionId);
    try {
        const reply = await api.post<{ model: string; overviewModel?: string }>(
            `/api/projects/${projectId}/sessions/${sessionId}/summaries`,
        );
        // 全体概要と要約詳細のモデル（#178。古いサーバーは model だけ）
        const model = finalModelLabel({
            ...llmModels(get().settings),
            detail: reply.model,
            overview: reply.overviewModel ?? reply.model,
        });
        if (ctx.status.summaryFinished(sessionId)) {
            // 返事より先に作り終えていた（「作成中」にすると、消すきっかけがもう来ない）
            void ctx.sessions.reloadAfterFinalSummary(sessionId);
            return;
        }
        // 結果は WebSocket（summary.delta）で届く。届くまでは「作成中」と出す。
        // 返事より先に届いた分があれば残す
        set((s) => ({
            generating: {
                sessionId,
                model,
                text: s.generating?.sessionId === sessionId ? s.generating.text : '',
            },
        }));
    } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
            toast.error('録音中または録音を終えた直後です。少し待ってから再生成してください');
        } else if (e instanceof ApiError && e.status === 410) {
            toast.error('文字起こしが期限切れのため、再生成できません');
        } else {
            toast.error(`要約を再生成できません: ${(e as Error).message}`);
        }
    }
}
