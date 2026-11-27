// 要約パネル（SummaryPanel）に出す文と、作り直せるかの判定（spec/flows.md 6.5・6.7）
import type { Generating, Session, Summary } from '@/api/types';
import { sessionMessages } from '@/features/session/i18n';
import { type OllamaModels, finalModelLabel } from '@/features/settings/settings';

// 世代の見出し。全体概要のモデルが要約詳細と違えば、両方出す（#178）
export function summaryLabel(summary: Summary, models: OllamaModels): string {
    const label = finalModelLabel({
        ...models,
        overview: summary.overviewModel ?? summary.model,
        detail: summary.model,
    });
    return sessionMessages.t('summaryView.label', { model: label, date: summary.generatedAt });
}

// 作っている途中で本文がまだ届いていない間に出しておくもの（#80）。作り直しなら今の要約を、
// 録音を終えた直後なら途中の要約を出す。途中の要約は最終の要約ができた後も残ることがあるので、最終の要約を先に見る
export function generatingPlaceholder(
    session: Session,
    summary: Summary | undefined,
    liveDraft: { sessionId: string; text: string } | null,
): { label: string; text: string; live: boolean } | null {
    const live = liveDraft?.sessionId === session.id ? liveDraft.text : session.liveSummary;
    if (summary?.text) {
        return { label: sessionMessages.t('summaryView.placeholderCurrent'), text: summary.text, live: false };
    }
    return live ? { label: sessionMessages.t('summaryView.placeholderLive'), text: live, live: true } : null;
}

// 作り直せるのは、録音を終えていて文字起こしが残っているセッション。
// ほかのセッションの要約を作っている間は押せない（作成中の表示は1つだけ持つので、二重に頼まないように）
export function canRegenerateSummary(session: Session, generating: Generating | null): boolean {
    return (
        session.status !== 'recording' &&
        session.loaded === true &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        generating === null
    );
}

// 最終の要約を作れなかったときの案内（spec/flows.md 6.7）。LLM が戻っていれば、作り直しを勧める
export function summaryFailureHint(
    session: Session,
    canRegenerate: boolean,
    llmDown: boolean,
    llmName: string,
): string {
    if (!canRegenerate) {
        return session.files?.transcript === false || session.transcript.length === 0
            ? sessionMessages.t('summaryView.hintNoTranscript')
            : sessionMessages.t('summaryView.hintBusy');
    }
    return llmDown
        ? sessionMessages.t('summaryView.hintLlmDown', { llm: llmName })
        : sessionMessages.t('summaryView.hintLlmUp', { llm: llmName });
}
