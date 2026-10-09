// 仮データ。後で /api/projects と /api/projects/{pid}/sessions/… から取る
export type TranscriptLine = {
    time: string;
    text: string;
};

// 最終の要約。作り直すたびに増えていく（spec 6.5 節）
export type Summary = {
    generationId: string;
    model: string;
    generatedAt: string;
    text: string;
};

export type Session = {
    id: string;
    title: string;
    startedAt: string;
    // recording は録音中（ほかの端末で録音しているものも含む）
    status: 'recording' | 'done' | 'interrupted';
    transcript: TranscriptLine[];
    summaries: Summary[];
};

export type Project = {
    id: string;
    name: string;
    path: string;
    sessions: Session[];
};

// 作成中の最終の要約。summary.delta（spec 7.2 節）で届いた分
export type Generating = { sessionId: string; model: string; text: string };

// 下のダミーデータは要約を1つだけ書いておき、initialProjects で Summary の形にする
type SeedProject = Omit<Project, 'sessions'> & {
    sessions: (Omit<Session, 'summaries'> & { summary: string })[];
};

const seedProjects: SeedProject[] = [
    {
        id: 'D--work-meetings-a1b2c3',
        name: 'meetings',
        path: 'D:\\work\\meetings',
        sessions: [
            {
                id: '20261009-143012',
                title: '新機能のリリース計画',
                startedAt: '2026-10-09 14:30',
                status: 'done',
                transcript: [
                    { time: '00:00:03', text: '今日はリリース計画について決めていきたいと思います。' },
                    {
                        time: '00:00:15',
                        text: 'まずステージング環境での確認ですが、来週の水曜までに終わらせる予定です。',
                    },
                    { time: '00:01:02', text: '負荷試験はまだ手をつけていないので、そこが一番のリスクですね。' },
                    { time: '00:01:40', text: '負荷試験は外部のツールを使う方向で、見積もりを今週中にもらいます。' },
                    { time: '00:02:31', text: 'リリース日は再来週の月曜を目標にして、金曜に最終判断しましょう。' },
                ],
                summary: `## 決まったこと
- リリース日は再来週の月曜を目標にする。最終判断は金曜
- ステージング環境での確認は来週の水曜までに終える

## 課題
- 負荷試験が未着手。外部ツールを使う方向で、今週中に見積もりをもらう`,
            },
            {
                id: '20261002-100000',
                title: '週次の進捗確認',
                startedAt: '2026-10-02 10:00',
                status: 'done',
                transcript: [
                    { time: '00:00:05', text: 'では今週の進捗を順番にお願いします。' },
                    { time: '00:00:20', text: 'ログイン画面の改修は終わって、いまレビュー待ちです。' },
                    { time: '00:00:48', text: '通知機能は設計で少し詰まっていて、来週に持ち越しになりそうです。' },
                ],
                summary: `## 進捗
- ログイン画面の改修：完了、レビュー待ち
- 通知機能：設計で詰まっており、来週に持ち越し`,
            },
            {
                id: '20260925-150000',
                title: 'デザインの方向性の相談',
                startedAt: '2026-09-25 15:00',
                status: 'interrupted',
                transcript: [
                    { time: '00:00:02', text: 'トップページの配色について、いくつか案を持ってきました。' },
                    { time: '00:00:30', text: 'A 案は落ち着いた感じで、B 案はもう少し明るめです。' },
                ],
                summary: `## 話したこと
- トップページの配色について A 案（落ち着いた色）と B 案（明るめ）を比較した
- 録音が途中で切れたため、結論は記録されていない`,
            },
        ],
    },
    {
        id: 'D--work-lectures-d4e5f6',
        name: 'lectures',
        path: 'D:\\work\\lectures',
        sessions: [
            {
                id: '20261009-130000',
                title: 'アルゴリズム 二分探索',
                startedAt: '2026-10-09 13:00',
                status: 'done',
                transcript: [
                    { time: '00:00:06', text: '今日はソート済みの配列から値を探す二分探索をやります。' },
                    { time: '00:01:12', text: '探す範囲を毎回半分にしていくので、計算量はログ n になります。' },
                    {
                        time: '00:02:45',
                        text: '境界の扱いで無限ループになりやすいので、left と right の更新に注意してください。',
                    },
                ],
                summary: `## 要点
- ソート済みの配列で、探す範囲を毎回半分にしていく
- 計算量は $O(\\log n)$
- \`left\` と \`right\` の更新を間違えると無限ループになる

## 実装例

\`\`\`python
def binary_search(a: list[int], target: int) -> int:
    left, right = 0, len(a) - 1
    while left <= right:
        mid = (left + right) // 2
        if a[mid] == target:
            return mid
        if a[mid] < target:
            left = mid + 1
        else:
            right = mid - 1
    return -1
\`\`\``,
            },
            {
                id: '20261008-090000',
                title: '線形代数 固有値と固有ベクトル',
                startedAt: '2026-10-08 09:00',
                status: 'done',
                transcript: [
                    { time: '00:00:10', text: '今日は固有値と固有ベクトルを扱います。' },
                    {
                        time: '00:01:05',
                        text: '行列 A に対して Av = λv となるゼロでないベクトル v を固有ベクトルと呼びます。',
                    },
                    { time: '00:02:40', text: 'λ は特性方程式 det(A − λI) = 0 を解けば求まります。' },
                ],
                summary: `## 要点
- $A\\mathbf{v} = \\lambda \\mathbf{v}$ を満たすゼロでないベクトル $\\mathbf{v}$ が**固有ベクトル**、$\\lambda$ が**固有値**
- 固有値は次の特性方程式を解いて求める

$$
\\det(A - \\lambda I) = 0
$$`,
            },
            {
                id: '20261001-090000',
                title: '線形代数 行列式',
                startedAt: '2026-10-01 09:00',
                status: 'done',
                transcript: [
                    { time: '00:00:08', text: '今日は行列式の定義と性質を見ていきます。' },
                    { time: '00:01:30', text: '2 行 2 列の場合は ad − bc で計算できます。' },
                ],
                summary: `## 要点
- 2 行 2 列の行列式は次のとおり

$$
\\det \\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix} = ad - bc
$$

- 行列式が 0 でないとき、逆行列が存在する

| 行列式 | 逆行列 |
| --- | --- |
| $\\det A \\neq 0$ | ある |
| $\\det A = 0$ | ない |`,
            },
        ],
    },
];

export const initialProjects: Project[] = seedProjects.map((p) => ({
    ...p,
    sessions: p.sessions.map(({ summary, ...s }) => ({
        ...s,
        summaries: [{ generationId: s.id, model: 'qwen3.5:4b', generatedAt: s.startedAt, text: summary }],
    })),
}));

// 選べる値。後で GET /api/settings/options から取る
export const whisperModels = ['large-v3-turbo', 'large-v3', 'medium', 'small'];
export const computeTypes = ['float16', 'int8_float16', 'int8'];
export const ollamaModels = ['qwen3.5:4b', 'gemma3:4b', 'llama3.2:3b'];

// フォルダの中身。後で GET /api/fs?path=… から取る。null はファイル
type DirTree = { [name: string]: DirTree | null };

const mockFs: Record<string, DirTree> = {
    'D:\\work': {
        meetings: {
            weekly: { 'agenda.md': null, 'notes.md': null },
            'kick-off': { 'slides.pdf': null, 'photo.png': null },
            'release-plan.md': null,
            'glossary.txt': null,
        },
        lectures: {
            math: { 'syllabus.pdf': null, 'week3.md': null },
            physics: {},
            english: {},
            'algorithms.html': null,
        },
        interviews: {},
        notes: { 'todo.txt': null, 'memo.docx': null },
    },
};

function findTree(root: string, segments: string[]): DirTree {
    let tree: DirTree | null | undefined = mockFs[root];
    for (const s of segments) {
        tree = tree?.[s];
    }
    return tree ?? {};
}

// root の下の segments をたどった先にあるフォルダの名前を返す
export function listDirs(root: string, segments: string[]): string[] {
    const tree = findTree(root, segments);
    return Object.keys(tree)
        .filter((name) => tree[name] !== null)
        .sort();
}

// root の下の segments をたどった先にあるファイルのうち、指定した拡張子のものを返す
export function listFiles(root: string, segments: string[], extensions: string[]): string[] {
    const tree = findTree(root, segments);
    return Object.keys(tree)
        .filter((name) => tree[name] === null && extensions.some((ext) => name.toLowerCase().endsWith(ext)))
        .sort();
}

// 参考資料セット（spec 5.4 節の contextSets）。後で /api/projects/{pid}/context-sets から取る
export type ContextSet = {
    id: string;
    status: 'generating' | 'ready' | 'failed';
    materials: string[];
};

// プロジェクトで今選んでいる状態（spec 5.4 節の selection）
export type ContextSelection = {
    setId: string | null;
    useHotwords: boolean;
    useContext: boolean;
};

// 資料のファイル名だけを並べた、セットの表示名
export function contextSetName(set: ContextSet) {
    return set.materials.map((m) => m.split('\\').at(-1)).join(', ');
}

export const initialContextSets: Record<string, ContextSet[]> = {
    'D--work-meetings-a1b2c3': [
        {
            id: '20261009-090501',
            status: 'ready',
            materials: ['D:\\work\\meetings\\weekly\\agenda.md', 'D:\\work\\meetings\\weekly\\notes.md'],
        },
    ],
};
