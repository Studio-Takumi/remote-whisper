// 画面に出すプロジェクトの一覧：キャッシュのプロジェクトとセッションの一覧に、手元で中身を積み上げている
// セッションを重ねる（#361）。手元のものはサーバーの一覧のものより先に使い、一覧にまだなければ先頭に足す
import type { ProjectInfo } from '@/api/projects';
import type { Project, Session } from '@/api/types';
import type { LocalSession } from '@/features/projects/localSessions';

// 一覧を取り直したときに、中身（文字起こし・要約）も取り直すか：録音中だったものと、ファイルが増えた・消えたもの
export function needsReload(old: Session | undefined, next: Session) {
    return (
        !!old &&
        (old.status === 'recording' ||
            old.files?.summaries !== next.files?.summaries ||
            old.files?.transcript !== next.files?.transcript ||
            old.files?.finalTranscripts !== next.files?.finalTranscripts)
    );
}

export function buildProjects(
    infos: ProjectInfo[],
    lists: (Session[] | undefined)[],
    local: LocalSession[],
): Project[] {
    return infos.map((p, i) => {
        const mine = local.filter((x) => x.projectId === p.id).map((x) => x.session);
        const rows = (lists[i] ?? []).map((row) => mine.find((x) => x.id === row.id) ?? row);
        const extra = mine.filter((x) => !rows.includes(x));
        return { ...p, sessions: [...extra, ...rows] };
    });
}
