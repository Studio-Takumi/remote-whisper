// 続けて並べ替えたときの、保存の途中のものと保存できたものの記録（#361）。失敗したら、画面に出しているのが
// その並べ替えのときだけ、残っているうちで一番新しい並び（保存の途中のものか、保存できたもの）に戻す
export type ProjectOrder = { ids: string[]; projectOrder: string[] };

export class ReorderTracker {
    private seq = 0;
    // 画面に出している並べ替えの番号
    private shown = 0;
    // 最後に保存できた並び（最初は、並べ替える前の並び）
    private saved: { seq: number; order: ProjectOrder } | null = null;
    private readonly pending = new Map<number, ProjectOrder>();

    // 並べ替えを始める。before は今の画面の並び。番号を返す
    start(before: ProjectOrder, next: ProjectOrder): number {
        if (this.pending.size === 0) {
            this.saved = { seq: this.seq, order: before };
        }
        this.seq += 1;
        this.pending.set(this.seq, next);
        this.shown = this.seq;
        return this.seq;
    }

    succeed(seq: number) {
        const order = this.pending.get(seq);
        this.pending.delete(seq);
        if (order && (!this.saved || seq > this.saved.seq)) {
            this.saved = { seq, order };
        }
    }

    // 失敗した。戻す並びを返す（もっと新しい並べ替えを出しているなら、戻さないので null）
    fail(seq: number): ProjectOrder | null {
        this.pending.delete(seq);
        if (this.shown !== seq) {
            return null;
        }
        const candidates = [...this.pending.entries()].map(([s, order]) => ({ seq: s, order }));
        if (this.saved) {
            candidates.push(this.saved);
        }
        const back = candidates.reduce<(typeof candidates)[number] | null>(
            (top, x) => (!top || x.seq > top.seq ? x : top),
            null,
        );
        this.shown = back?.seq ?? 0;
        return back?.order ?? null;
    }
}

const trackers = new WeakMap<object, ReorderTracker>();

// ストアごとに 1 つ
export function reorderTracker(store: object): ReorderTracker {
    let tracker = trackers.get(store);
    if (!tracker) {
        tracker = new ReorderTracker();
        trackers.set(store, tracker);
    }
    return tracker;
}
