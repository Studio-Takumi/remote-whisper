// 仮データ。後で /api/projects と /api/projects/{pid}/sessions から取る
export type Project = {
    id: string;
    name: string;
    sessions: string[];
};

export const projects: Project[] = [
    { id: 'project-a', name: 'プロジェクトA', sessions: ['セッションA1', 'セッションA2', 'セッションA3'] },
    { id: 'project-b', name: 'プロジェクトB', sessions: ['セッションB1', 'セッションB2', 'セッションB3'] },
];
