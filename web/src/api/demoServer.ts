// デモ版（#413）で、サーバーの代わりに同梱したデータで API に答える（GET だけ。サーバーにはつながない）。
// 答える中身と、ないときのステータス・メッセージは、サーバーの routes/projects.py・routes/sessions/read.py と同じ
import type { DemoIndex, DemoSession, DemoSummaryInfo } from '@/api/demoTypes';

export type DemoResponse = { status: number; body: unknown };

export type LoadDemoSession = (projectId: string, sessionId: string) => Promise<DemoSession> | null;

export type DemoRow = DemoIndex['sessions'][string][number];

// 同梱したデータの見え方を、そのときどきで変えるもの（リプレイ #416 の、録音中・録音を終えた後の形）。
// row は一覧の行、session はセッションの中身。変えないものはそのまま返す
export type DemoOverlay = {
    row(projectId: string, row: DemoRow): DemoRow;
    session(projectId: string, sessionId: string, data: DemoSession): DemoSession;
};

const ID_RE = /^\d{8}-\d{6}$/;

const ok = (body: unknown): DemoResponse => ({ status: 200, body });
const fail = (status: number, detail: string): DemoResponse => ({ status, body: { detail } });
const gone = (what: string) => fail(410, `${what}は保存期間を過ぎたため消えています`);

// 表示する最終の要約。今の全体概要と要約詳細のモデルの組で作ったうちいちばん新しいもの。
// その組のものがなければ、モデルを問わずいちばん新しいもの（session_reader.py の pick_latest）
export function pickLatest(summaries: DemoSummaryInfo[], models: DemoIndex['models']) {
    const same = summaries.filter((s) => s.model === models.detail && s.overviewModel === models.overview);
    const pool = same.length > 0 ? same : summaries;
    return pool.reduce<DemoSummaryInfo | undefined>(
        (a, b) => (!a || b.generationId > a.generationId ? b : a),
        undefined,
    );
}

export class DemoServer {
    private readonly index: DemoIndex;
    private readonly loadSession: LoadDemoSession;
    private readonly overlay: DemoOverlay | null;

    constructor(index: DemoIndex, loadSession: LoadDemoSession, overlay: DemoOverlay | null = null) {
        this.index = index;
        this.loadSession = loadSession;
        this.overlay = overlay;
    }

    async respond(method: string, path: string): Promise<DemoResponse> {
        if (method !== 'GET') {
            return fail(403, 'デモ版では変更できません');
        }
        const parts = path.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== 'api' || parts[1] !== 'projects') {
            return fail(404, 'デモ版にはありません');
        }
        const [pid, kind, sid, ...rest] = parts.slice(2);
        if (pid === undefined) {
            return ok(this.index.projects);
        }
        const rows = this.index.sessions[pid];
        if (!rows) {
            return fail(404, `プロジェクト ${pid} はありません`);
        }
        if (kind === 'context-sets' && sid === undefined) {
            return ok(this.index.contextSets[pid] ?? []);
        }
        if (kind !== 'sessions') {
            return fail(404, 'デモ版にはありません');
        }
        if (sid === undefined) {
            return ok(rows.map((r) => this.overlay?.row(pid, r) ?? r));
        }
        const row = rows.find((r) => r.id === sid);
        const load = row && ID_RE.test(sid) ? this.loadSession(pid, sid) : null;
        if (!row || !load) {
            return fail(404, `セッション ${sid} はありません`);
        }
        const data = await load;
        if (!this.overlay) {
            return this.sessionPart(row, data, rest);
        }
        return this.sessionPart(this.overlay.row(pid, row), this.overlay.session(pid, sid, data), rest);
    }

    private sessionPart(row: DemoRow, data: DemoSession, rest: string[]): DemoResponse {
        const [what, gid, ...extra] = rest;
        if (extra.length > 0) {
            return fail(404, 'デモ版にはありません');
        }
        if (what === undefined) {
            return ok(data.transcript ? { ...row, transcriptMeta: data.transcript.meta } : row);
        }
        if (what === 'transcript' && gid === undefined) {
            return data.transcript ? ok(data.transcript) : gone('文字起こし');
        }
        if (what === 'final-transcripts') {
            return gid === undefined ? ok(data.finalTranscripts) : this.finalTranscript(data, gid);
        }
        if (what === 'summaries') {
            return gid === undefined ? ok(data.summaries) : this.summary(data, gid);
        }
        return fail(404, 'デモ版にはありません');
    }

    private finalTranscript(data: DemoSession, gid: string): DemoResponse {
        const id = gid === 'latest' ? data.finalTranscripts.at(-1)?.generationId : gid;
        if (gid === 'latest' && id === undefined) {
            return gone('浄書済み文字起こし');
        }
        if (!id || !ID_RE.test(id)) {
            return fail(404, '浄書済み文字起こしがありません');
        }
        const meta = data.finalTranscripts.find((m) => m.generationId === id);
        return meta ? ok({ meta, lines: data.finalTranscriptLines[id] }) : gone('浄書済み文字起こし');
    }

    private summary(data: DemoSession, gid: string): DemoResponse {
        let id = gid;
        if (gid === 'latest') {
            const latest = pickLatest(data.summaries, this.index.models);
            if (!latest) {
                return data.liveSummary !== undefined
                    ? ok({ kind: 'live', text: data.liveSummary })
                    : fail(404, '要約はまだありません');
            }
            id = latest.generationId;
        }
        const info = ID_RE.test(id) ? data.summaries.find((s) => s.generationId === id) : undefined;
        return info
            ? ok({ kind: 'final', ...info, text: data.summaryTexts[id] })
            : fail(404, `要約 ${id} はありません`);
    }
}
