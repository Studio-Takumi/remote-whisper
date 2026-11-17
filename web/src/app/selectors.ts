// ストアの状態から、選択中のものを取り出すセレクタ
import type { ContextSelection, ContextSet, Project, Session } from '@/api/types';
import type { AppState } from '@/app/appState';
import { type OllamaModels, isCurrentFinalSummary } from '@/features/settings/settings';

// 毎回同じ参照を返すように、空のときも定数を返す
const NO_PROJECTS: Project[] = [];

export const visibleProjects = (s: AppState) => (s.noProjects ? NO_PROJECTS : s.projects);
export const currentProject = (s: AppState) => visibleProjects(s).find((p) => p.id === s.selection.projectId);
export const currentSession = (s: AppState) => currentProject(s)?.sessions.find((x) => x.id === s.selection.sessionId);

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

// 開いているプロジェクトで使う参考資料セットの選択。sets はそのプロジェクトの参考資料セットの一覧。
// 新しいオブジェクトを返すことがあるので、使うときは useShallow で包む
export const currentContextSelection = (s: AppState, sets: ContextSet[]): ContextSelection => {
    const project = currentProject(s);
    // 手元で変えたもの → サーバーに保存されているもの → 既定（ready のうち最初に作ったもの）
    return (
        (project && (s.contextSelections[project.id] ?? project.selection)) ?? {
            setId: sets.find((x) => x.status === 'ready')?.id ?? null,
            useHotwords: true,
            useContext: true,
            pickTerms: true,
        }
    );
};
