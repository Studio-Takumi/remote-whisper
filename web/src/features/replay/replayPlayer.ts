// 記録したメッセージを、記録の時刻どおりに渡す（デモ版のリプレイ #416）。時刻は再生を始めてからの秒。
// 待つ時間は始めた時刻から測る（遅れが積み重ならないように）。止めたら、それ以降は渡さない
export type TimedMessage<T> = { t: number; msg: T };

export class ReplayPlayer<T> {
    private items: TimedMessage<T>[] = [];
    private next = 0;
    private startedAt = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    private readonly deliver: (msg: T, t: number) => void;
    private readonly onEnd: () => void;

    constructor(deliver: (msg: T, t: number) => void, onEnd: () => void) {
        this.deliver = deliver;
        this.onEnd = onEnd;
    }

    // 再生中か（最後まで渡した・止めたら false）
    get playing() {
        return this.timer !== undefined;
    }

    // 最初から再生する。items は時刻の順
    play(items: TimedMessage<T>[]) {
        this.stop();
        // 渡した先でやり直されたことに気づけるように、毎回別の配列にする
        this.items = [...items];
        this.next = 0;
        this.startedAt = Date.now();
        this.schedule();
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.items = [];
    }

    private schedule() {
        const item = this.items[this.next];
        if (!item) {
            this.timer = undefined;
            this.items = [];
            this.onEnd();
            return;
        }
        const wait = Math.max(0, this.startedAt + item.t * 1000 - Date.now());
        this.timer = setTimeout(() => this.tick(), wait);
    }

    // 時刻が来たものをまとめて渡す。渡した先で止められた・やり直されたら、そこでやめる
    private tick() {
        const items = this.items;
        const now = Date.now() - this.startedAt;
        while (this.items === items && this.next < items.length && items[this.next].t * 1000 <= now) {
            const item = items[this.next];
            this.next += 1;
            this.deliver(item.msg, item.t);
        }
        if (this.items === items) {
            this.schedule();
        }
    }
}
