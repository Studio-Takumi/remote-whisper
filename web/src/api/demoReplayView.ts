// デモ版のリプレイ（#416）で、DemoServer が答える一覧の行とセッションの中身を、再生した時刻のときに
// サーバーが返していたはずの形にする（DemoServer の overlay）。
// - 録音を終えたこと（最後の区間の final の後）が届くまで: 録音中の行。文字起こしはそこまでに届いた final、途中の要約はそこまでにできたもの
// - 録音を終えてから最終のタイトルが届くまで: 録音を終えた行。最終の要約はまだなく、浄書は届いてから
// - 最終のタイトルが届いた後: 同梱したまま
import type { DemoOverlay, DemoRow } from '@/api/demoServer';
import type { DemoJson, DemoLine, DemoReplay, DemoSession } from '@/api/demoTypes';
import { formatClock } from '@/lib/time';

export type ReplayTarget = { projectId: string; sessionId: string };

type Timed<T> = { t: number; value: T };

function lastUntil<T>(items: Timed<T>[], t: number): T | undefined {
    let found: T | undefined;
    for (const item of items) {
        if (item.t > t) {
            break;
        }
        found = item.value;
    }
    return found;
}

function valuesUntil<T>(items: Timed<T>[], t: number): T[] {
    return items.filter((item) => item.t <= t).map((item) => item.value);
}

// 見ている端末に録音を終えたこと（recordingState の stopped）が届く時刻。サーバーは、話している途中だった
// 最後の区間の final（と partial）を送り終えてから送る（spec/api.md 7.2）ので、stop の後に届いた最後の
// final・partial の時刻。なければ stop の時刻
export function watchStoppedAt(record: DemoReplay) {
    let at = record.stopAt;
    for (const { t, msg } of record.messages) {
        if (t > at && (msg.type === 'final' || msg.type === 'partial')) {
            at = t;
        }
    }
    return at;
}

export class ReplayView implements DemoOverlay {
    private readonly target: ReplayTarget;
    // 再生した時刻（録音を始めてからの秒）。再生していないときは 0（録音を始めたところ）、最後まで再生したら Infinity
    private elapsed = 0;
    private stopAt = Infinity;
    private finalTranscriptAt = Infinity;
    private finalTitleAt = Infinity;
    private lines: Timed<DemoLine>[] = [];
    private liveSummaries: Timed<string>[] = [];
    private titles: Timed<string>[] = [];

    constructor(target: ReplayTarget) {
        this.target = target;
    }

    // 記録から、時刻ごとの文字起こしの行・途中の要約・タイトルを拾っておく（画面の受け取りと同じ読み方）
    setRecord(record: DemoReplay) {
        // 録音を終えた行にするのは、見ている端末に stopped が届く時刻から（それまでの final は録音中の行として出す）
        this.stopAt = watchStoppedAt(record);
        this.lines = [];
        this.liveSummaries = [];
        this.titles = [];
        let draft: string | null = null;
        for (const { t, msg } of record.messages) {
            if (msg.type === 'final' && typeof msg.text === 'string' && msg.text) {
                this.lines.push({ t, value: { time: formatClock(Number(msg.start)), text: msg.text } });
            } else if (msg.type === 'summary.delta' && msg.kind === 'live') {
                draft = msg.replace ? String(msg.text) : draft === null ? null : draft + String(msg.text);
            } else if (msg.type === 'summary.done' && msg.kind === 'live' && draft !== null) {
                this.liveSummaries.push({ t, value: draft });
                draft = null;
            } else if (msg.type === 'title' && typeof msg.title === 'string') {
                this.titles.push({ t, value: msg.title });
                if (msg.provisional === false && this.finalTitleAt === Infinity) {
                    this.finalTitleAt = t;
                }
            } else if (msg.type === 'finalTranscript' && this.finalTranscriptAt === Infinity) {
                this.finalTranscriptAt = t;
            }
        }
    }

    seek(elapsed: number) {
        this.elapsed = elapsed;
    }

    private isTarget(projectId: string, sessionId: string) {
        return projectId === this.target.projectId && sessionId === this.target.sessionId;
    }

    // 同梱したままを出すか（リプレイのセッションでないか、最終のタイトルまで再生した）
    private asIs(projectId: string, sessionId: string) {
        return !this.isTarget(projectId, sessionId) || this.elapsed >= this.finalTitleAt;
    }

    row(projectId: string, row: DemoRow): DemoRow {
        if (this.asIs(projectId, row.id)) {
            return row;
        }
        const t = this.elapsed;
        const files = row.files as DemoJson;
        const changed = {
            ...row,
            title: lastUntil(this.titles, t) ?? null,
            files: {
                ...files,
                finalTranscripts: t >= this.finalTranscriptAt ? files.finalTranscripts : 0,
                summaries: 0,
                liveSummary: lastUntil(this.liveSummaries, t) !== undefined,
            },
        };
        if (t >= this.stopAt) {
            return changed;
        }
        return { ...changed, status: 'recording', endedAt: null, durationSec: null };
    }

    session(projectId: string, sessionId: string, data: DemoSession): DemoSession {
        if (this.asIs(projectId, sessionId)) {
            return data;
        }
        const t = this.elapsed;
        const done = t >= this.stopAt;
        const transcript = data.transcript && {
            ...data.transcript,
            // 録音中の文字起こしのファイルは、そこまでに届いた final の行
            lines: done ? data.transcript.lines : valuesUntil(this.lines, t),
        };
        const finalTranscript = t >= this.finalTranscriptAt;
        return {
            transcript,
            finalTranscripts: finalTranscript ? data.finalTranscripts : [],
            finalTranscriptLines: finalTranscript ? data.finalTranscriptLines : {},
            summaries: [],
            summaryTexts: {},
            liveSummary: lastUntil(this.liveSummaries, t),
        };
    }
}
