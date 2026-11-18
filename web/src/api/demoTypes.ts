// デモ版（#413）に同梱するデータの形。ビルド時（vite/demoHome.ts）に ~/.remote-whisper と同じ構成の home/ から作り、
// 画面では api/demoServer.ts がサーバーの代わりにこれで API に答える。中身はサーバーが返す JSON そのもの。
// ビルド時のコードからも読むので、ほかのファイルを import しない

export type DemoJson = Record<string, unknown>;

export type DemoLine = { time: string; text: string };

// GET .../summaries の 1 つ分
export type DemoSummaryInfo = {
    generationId: string;
    model: string;
    overviewModel: string;
    think: boolean;
    generatedAt: string;
    title: string | null;
};

// 1 つのセッションの中身（開いたときに取る分）
export type DemoSession = {
    // GET .../transcript。文字起こしのファイルがなければない
    transcript?: { meta: DemoJson; lines: DemoLine[] };
    // GET .../final-transcripts（古いものから）と、世代ごとの本文
    finalTranscripts: (DemoJson & { generationId: string })[];
    finalTranscriptLines: Record<string, DemoLine[]>;
    // GET .../summaries（古いものから）と、版ごとの本文
    summaries: DemoSummaryInfo[];
    summaryTexts: Record<string, string>;
    // 途中の要約（.tmp/<ID>/live-summary.md）
    liveSummary?: string;
};

// 最初に読む一覧（プロジェクトとセッションの行）
export type DemoIndex = {
    // GET /api/projects（並びは setting.json の projectOrder）
    projects: (DemoJson & { id: string })[];
    // GET /api/projects/{pid}/sessions（新しいものから）
    sessions: Record<string, (DemoJson & { id: string })[]>;
    // GET /api/projects/{pid}/context-sets
    contextSets: Record<string, DemoJson[]>;
    // 表示する要約を選ぶモデル（setting.json の全体概要と要約詳細。summaries/latest で使う）
    models: { overview: string; detail: string };
};
