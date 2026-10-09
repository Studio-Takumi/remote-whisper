// 仮データ。後で /api/projects と /api/projects/{pid}/sessions/… から取る
export type TranscriptLine = {
    time: string;
    text: string;
};

export type Session = {
    id: string;
    title: string;
    startedAt: string;
    status: 'done' | 'interrupted';
    transcript: TranscriptLine[];
    summary: string;
};

export type Project = {
    id: string;
    name: string;
    path: string;
    sessions: Session[];
};

export const projects: Project[] = [
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
- Av = λv を満たすゼロでないベクトル v が固有ベクトル、λ が固有値
- 固有値は特性方程式 det(A − λI) = 0 を解いて求める`,
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
- 2 行 2 列の行列式は ad − bc
- 行列式が 0 でないとき、逆行列が存在する`,
            },
        ],
    },
];

export function findSession(id: string): Session | undefined {
    return projects.flatMap((p) => p.sessions).find((s) => s.id === id);
}

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
