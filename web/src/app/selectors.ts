// ストアの状態とキャッシュから、選択中のものを取り出す（ストアの外の操作で使う。画面の部品は sessionHooks を使う）
import type { ContextSelection, ContextSet, Project, Session } from '@/api/types';
import type { AppState } from '@/app/appState';
import { readProjects, withDetail } from '@/app/sessionData';
import { findLocal } from '@/features/projects/localSessions';
import { type OllamaModels, isCurrentFinalSummary } from '@/features/settings/settings';

// 毎回同じ参照を返すように、空のときも定数を返す
const NO_PROJECTS: Project[] = [];

export const visibleProjects = (s: AppState) => (s.noProjects ? NO_PROJECTS : readProjects(s));
export const currentProject = (s: AppState) => visibleProjects(s).find((p) => p.id === s.selection.projectId);
export const currentSession = (s: AppState): Session | undefined => {
    const project = currentProject(s);
    const row = project?.sessions.find((x) => x.id === s.selection.sessionId);
    if (!project || !row) {
        return undefined;
    }
    return findLocal(s.localSessions, row.id) ? row : withDetail(s, project.id, row);
};

// 録音を終えていて文字起こしがあるのに、そのモデルの最終の要約がまだないか（作り直すかどうか）
export function needsSummaryFor(session: Session, models: OllamaModels) {
    return (
        session.loaded === true &&
        session.status !== 'recording' &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        !session.summaries.some((x) => isCurrentFinalSummary(x, models))
    );
}

// プロジェクトで使う参考資料セットの選択。sets はそのプロジェクトの参考資料セットの一覧。
// 手元で変えたもの（overrides） → サーバーに保存されているもの → 既定（ready のうち最初に作ったもの）
export function contextSelectionOf(
    project: Pick<Project, 'id' | 'selection'> | undefined,
    overrides: Record<string, ContextSelection>,
    sets: ContextSet[],
): ContextSelection {
    return (
        (project && (overrides[project.id] ?? project.selection)) ?? {
            setId: sets.find((x) => x.status === 'ready')?.id ?? null,
            useHotwords: true,
            useContext: true,
            pickTerms: true,
        }
    );
}

// 開いているプロジェクトで使う参考資料セットの選択
export const currentContextSelection = (s: AppState, sets: ContextSet[]): ContextSelection =>
    contextSelectionOf(currentProject(s), s.contextSelections, sets);
