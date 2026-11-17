// 要約パネルに出す最終の要約の世代（spec/flows.md 6.5）
import type { Session, Summary } from '@/api/types';
import { type OllamaModels, isCurrentFinalSummary } from '@/features/settings/settings';

// 手で選んだ世代。セッションを替えたときと、要約が増えた（作り直した）ときは既定に戻す
export type PickedSummary = { sessionId: string; count: number; generationId: string };

// 手で選んでいないときに出す最終の要約。今のモデルのものがあればそれ、なければいちばん新しいもの
export function defaultSummary(session: Session, models: OllamaModels): Summary | undefined {
    return session.summaries.findLast((s) => isCurrentFinalSummary(s, models)) ?? session.summaries.at(-1);
}

// 要約パネルに出している版
export function shownSummary(session: Session, models: OllamaModels, picked: PickedSummary | null) {
    const fallback = defaultSummary(session, models);
    return picked?.sessionId === session.id && picked.count === session.summaries.length
        ? (session.summaries.find((s) => s.generationId === picked.generationId) ?? fallback)
        : fallback;
}
