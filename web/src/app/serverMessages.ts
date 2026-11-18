// 常時の購読で受け取る、録音ごとではないメッセージ：最終の要約・最終の文字起こし・タイトル・
// ほかの端末での変更・要約の失敗・参考資料の進み具合（spec/api.md 7.2）
import { toast } from 'sonner';

import { isDemo, usesMockData } from '@/api/demo';
import type { ServerMessage } from '@/api/protocol';
import type { AppStore } from '@/app/appState';
import { readProjectInfos } from '@/app/sessionData';
import type { SessionSync } from '@/app/sessionSync';
import { cachedContextSets, refreshContextSets, updateCachedContextSets } from '@/features/materials/contextSetCache';
import type { Recorder } from '@/features/recording/recorderState';
import { LLM_NAMES, finalModelLabel, llmBackend, llmModels } from '@/features/settings/settings';

type Message<T extends ServerMessage['type']> = Extract<ServerMessage, { type: T }>;

export type MessageContext = { store: AppStore; recorder: Recorder; sessions: SessionSync };

// LLM（Ollama か LM Studio）につながらず、要約を作れなかった（#327）
function llmFailed(code: string) {
    return code === 'ollama_unavailable' || code === 'lmstudio_unavailable';
}

// 最終の要約（録音を終えた後と、作り直し）。少しずつ届く
function receiveFinalDelta({ store }: MessageContext, m: Message<'summary.delta'>) {
    store.setState((s) => {
        const same = s.generating?.sessionId === m.session;
        return {
            generating: {
                sessionId: m.session,
                model: same && s.generating ? s.generating.model : finalModelLabel(llmModels(s.settings)),
                text: (same && s.generating ? s.generating.text : '') + m.text,
            },
        };
    });
}

// プロジェクトの並びが変わった（ほかの端末からのものも。#173）。設定だけ取り直して、手元の一覧を並べ直す
// （一覧を取り直すと、続けて並び替えたときに古い応答で戻ることがある）
function receiveProjectOrder({ store, sessions }: MessageContext) {
    const get = store.getState;
    void get()
        .loadSettings()
        .then(() => {
            const ids = get().settings.projectOrder;
            const known = readProjectInfos();
            if (ids.some((id) => !known.some((p) => p.id === id))) {
                // 知らないプロジェクト（ほかの端末で作ったもの）があれば、一覧ごと取り直す
                void get().loadProjects();
            } else {
                sessions.sortProjectsBy(ids);
            }
        });
}

function receiveTitle({ recorder, sessions }: MessageContext, m: Message<'title'>) {
    sessions.patchSession(m.session, (x) => ({ ...x, title: m.title, provisionalTitle: m.provisional }));
    // 最終のタイトルは、最終の要約を保存した後に届く。保存されたものを取り直して表示を置き換える
    if (!m.provisional) {
        // 録音ごとの数字を送る（#206。最終の要約ができた）。同じ録音を 2 回送らない
        recorder.metrics.finish(m.session, true);
        void sessions.reloadAfterFinalSummary(m.session);
    }
}

// セッションの中身・一覧が変わった（ほかの端末からのものも）
function receiveSessionChange(ctx: MessageContext, m: ServerMessage) {
    const { sessions } = ctx;
    if (m.type === 'summary.delta' && m.kind === 'final') {
        receiveFinalDelta(ctx, m);
    } else if (m.type === 'finalTranscript' && !usesMockData) {
        // 最終の文字起こしができた（#121）。最終の要約を待っている間（一覧の取り直しでは中身を
        // 置き換えない）でも出せるように、そのセッションの最終の文字起こしだけを取ってきて足す。
        // 同梱したデータのデモ版（リプレイ #416）も、API（demoServer）から取る
        void sessions.receiveFinalTranscript(m.session, m.generationId);
    } else if (m.type === 'sessionMoved' && !isDemo) {
        // セッションを別のプロジェクトへ移した（#172）
        void sessions.reloadAfterMove(m.session, m.from, m.to);
    } else if (m.type === 'projectOrder' && !isDemo) {
        receiveProjectOrder(ctx);
    } else if (m.type === 'corrections' && !isDemo) {
        // 置き換えを足した・外した（#176）
        void sessions.refreshTranscripts(m.session);
    } else if (m.type === 'title') {
        receiveTitle(ctx, m);
    }
}

// 要約を作れなかった（作らなかった）・作り直しを頼んだ文字起こしができなかった
function receiveSessionError({ store, recorder, sessions }: MessageContext, m: Message<'error'>) {
    if (!m.session) {
        return;
    }
    const session = m.session;
    if (m.code === 'final_transcript_failed') {
        // 知らせは、ほかの error と同じくトーストに出す
        sessions.forgetFinalTranscript(session);
    }
    const summaryFailed = llmFailed(m.code) || m.code === 'summary_skipped' || m.code === 'summary_failed';
    if (summaryFailed) {
        // 最終の要約を待っていた録音は、失敗として数字を送る（#206）
        recorder.metrics.finish(session, false);
    }
    if (!summaryFailed && m.code !== 'write_failed') {
        return;
    }
    // 作成中の表示を消す。Ollama の失敗なら、途中の要約の下書きも捨てる（届きかけの分が、次の回の要約に
    // 混ざらないように。音声の write_failed では捨てない）
    store.setState((s) => ({
        generating: s.generating?.sessionId === session ? null : s.generating,
        liveDraft: llmFailed(m.code) && s.liveDraft?.sessionId === session ? null : s.liveDraft,
    }));
    // 最終の要約の失敗はサーバーが記録している（spec/flows.md 6.7）。手元で決めつけず、取り直して記録に合わせる
    // （録音を終えた直後の途中の要約や音声の失敗を、要約の失敗と取り違えないように）
    if (store.getState().recordingSessionId !== session) {
        void store.getState().loadProjects();
    }
}

// 参考資料セットの作成の進み具合（ほかの端末で始めたものも）
function receiveContextSet({ store }: MessageContext, m: Message<'contextSet'>, pid: string) {
    const known = cachedContextSets(pid).find((x) => x.id === m.id);
    if (!known) {
        // 知らないセット（ほかの端末で始めたもの）は、一覧ごと取り直す
        void refreshContextSets([pid]);
        return;
    }
    updateCachedContextSets(pid, (sets) => sets.map((x) => (x.id === m.id ? { ...x, status: m.status } : x)));
    if (known.status === 'generating' && m.status === 'ready') {
        toast.success('参考資料ができました');
    } else if (known.status === 'generating' && m.status === 'failed') {
        const llm = LLM_NAMES[llmBackend(store.getState().settings)];
        toast.error(`参考資料を作れませんでした（資料を読めないか、${llm} に接続できません）`);
    }
}

export function receiveServerMessage(ctx: MessageContext, m: ServerMessage) {
    receiveSessionChange(ctx, m);
    if (m.type === 'error') {
        receiveSessionError(ctx, m);
        // 録音を始める・続けるときのエラーは、それぞれの処理でまとめて出す
        if (!ctx.recorder.starting && !ctx.recorder.resuming) {
            toast.error(m.message);
        }
    }
    // project のない contextSet（モックの /api/mock/context-set のまね）は、どのプロジェクトか分からないので無視する
    if (m.type === 'contextSet' && m.project) {
        receiveContextSet(ctx, m, m.project);
    }
}
