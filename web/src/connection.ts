// WebSocket /ws の接続（spec 7.2）。接続は1本で、録音とサーバーの状態の通知の両方に使う
import type { ClientMessage, ServerMessage } from '@/protocol';

type Listener = (message: ServerMessage) => void;

function wsUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/ws`;
}

// 切れたらつなぎ直すまでの待ち時間（ミリ秒）。失敗するたびに伸ばす
const RETRY_DELAYS = [500, 1000, 2000, 4000, 8000];

class Connection {
    private ws: WebSocket | null = null;
    private opening: Promise<void> | null = null;
    private readonly listeners = new Set<Listener>();
    private readonly stateListeners = new Set<(connected: boolean) => void>();
    private keepAlive = false;
    private retries = 0;
    private retryTimer: ReturnType<typeof setTimeout> | undefined;

    // つなぎ続ける。切れたら、間隔を伸ばしながらつなぎ直す（アプリの起動時に1回呼ぶ）
    start() {
        if (this.keepAlive) {
            return;
        }
        this.keepAlive = true;
        this.reconnect();
    }

    private reconnect() {
        clearTimeout(this.retryTimer);
        this.open().catch(() => {
            // 一度もつながっていないときも、つながっていないことを知らせる
            this.setConnected(false);
            this.scheduleRetry();
        });
    }

    private scheduleRetry() {
        if (!this.keepAlive) {
            return;
        }
        const delay = RETRY_DELAYS[Math.min(this.retries, RETRY_DELAYS.length - 1)];
        this.retries += 1;
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.reconnect(), delay);
    }

    // つながった・切れたときに呼ぶ。戻り値の関数でやめる
    onStateChange(listener: (connected: boolean) => void) {
        this.stateListeners.add(listener);
        return () => {
            this.stateListeners.delete(listener);
        };
    }

    private setConnected(connected: boolean) {
        this.stateListeners.forEach((l) => l(connected));
    }

    // つながっていなければつなぐ。つながったら resolve する
    open(timeoutMs = 5000): Promise<void> {
        if (this.ws?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        if (this.opening) {
            return this.opening;
        }
        this.opening = new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(wsUrl());
            ws.binaryType = 'arraybuffer';
            const timer = setTimeout(() => {
                ws.close();
                reject(new Error('サーバーにつながりません'));
            }, timeoutMs);
            ws.onopen = () => {
                clearTimeout(timer);
                this.ws = ws;
                this.retries = 0;
                this.setConnected(true);
                resolve();
            };
            ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error('サーバーにつながりません'));
            };
            ws.onclose = () => {
                if (this.ws === ws) {
                    this.ws = null;
                    this.setConnected(false);
                    this.scheduleRetry();
                }
            };
            ws.onmessage = (e: MessageEvent) => {
                if (typeof e.data !== 'string') {
                    return;
                }
                const message = JSON.parse(e.data) as ServerMessage;
                this.listeners.forEach((l) => l(message));
            };
        }).finally(() => {
            this.opening = null;
        });
        return this.opening;
    }

    get isOpen() {
        return this.ws?.readyState === WebSocket.OPEN;
    }

    // 届いたメッセージを受け取る。戻り値の関数で受け取りをやめる
    subscribe(listener: Listener) {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    send(message: ClientMessage) {
        this.ws?.send(JSON.stringify(message));
    }

    sendBinary(data: ArrayBuffer) {
        this.ws?.send(data);
    }

    // 条件に合うメッセージが来るまで待つ
    waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 5000): Promise<T> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                unsubscribe();
                reject(new Error('サーバーから応答がありません'));
            }, timeoutMs);
            const unsubscribe = this.subscribe((m) => {
                if (pred(m)) {
                    clearTimeout(timer);
                    unsubscribe();
                    resolve(m);
                }
            });
        });
    }
}

export const connection = new Connection();

// 16kHz で約 0.5 秒ごとに1チャンクにして送る
const CHUNK_SAMPLES = 8000;

// 音声の送信。先頭4バイトに連番（uint32 LE）を付けて送り、ack が来るまで手元に残しておく
export class AudioSender {
    private seq = 0;
    private readonly pending = new Map<number, ArrayBuffer>();
    private buffer = new Int16Array(CHUNK_SAMPLES);
    private length = 0;

    private readonly onPendingChange: (count: number) => void;

    constructor(onPendingChange: (count: number) => void = () => {}) {
        this.onPendingChange = onPendingChange;
    }

    push(pcm: Int16Array) {
        let offset = 0;
        while (offset < pcm.length) {
            const n = Math.min(CHUNK_SAMPLES - this.length, pcm.length - offset);
            this.buffer.set(pcm.subarray(offset, offset + n), this.length);
            this.length += n;
            offset += n;
            if (this.length === CHUNK_SAMPLES) {
                this.flush();
            }
        }
    }

    // 溜まっている分を半端でも送る（録音を終えるときなど）
    flush() {
        if (this.length === 0) {
            return;
        }
        const frame = new ArrayBuffer(4 + this.length * 2);
        new DataView(frame).setUint32(0, this.seq, true);
        new Int16Array(frame, 4).set(this.buffer.subarray(0, this.length));
        this.pending.set(this.seq, frame);
        connection.sendBinary(frame);
        this.seq += 1;
        this.length = 0;
        this.onPendingChange(this.pending.size);
    }

    // ここまでの音声はサーバーが受け取ったので、手元から消す
    ack(seq: number) {
        for (const key of this.pending.keys()) {
            if (key <= seq) {
                this.pending.delete(key);
            }
        }
        this.onPendingChange(this.pending.size);
    }

    // サーバーに受け取ってほしい次の連番（ack されていない最初のもの）。resume の nextSeq に使う
    get nextSeq() {
        return this.pending.size > 0 ? Math.min(...this.pending.keys()) : this.seq;
    }

    // ack されていない音声を、連番の順に送り直す（つなぎ直した後、サーバーの ack を受けてから呼ぶ）
    resend() {
        for (const key of [...this.pending.keys()].sort((a, b) => a - b)) {
            connection.sendBinary(this.pending.get(key)!);
        }
    }
}
