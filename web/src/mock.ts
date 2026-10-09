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

// 選べる値。後で GET /api/settings/options から取る
export const whisperModels = ['large-v3-turbo', 'large-v3', 'medium', 'small'];
export const computeTypes = ['float16', 'int8_float16', 'int8'];
export const ollamaModels = ['qwen3.5:4b'];

// フォルダの中身。後で GET /api/fs?path=… から取る
type DirTree = { [name: string]: DirTree };

const mockFs: Record<string, DirTree> = {
    'D:\\work': {
        meetings: { weekly: {}, 'kick-off': {} },
        lectures: { math: {}, physics: {}, english: {} },
        interviews: {},
        notes: {},
    },
};

// root の下の segments をたどった先にあるフォルダの名前を返す
export function listDirs(root: string, segments: string[]): string[] {
    let tree: DirTree | undefined = mockFs[root];
    for (const s of segments) {
        tree = tree?.[s];
    }
    return Object.keys(tree ?? {}).sort();
}
