// 録音中のセッションに、この端末のマイクを音源として参加する（#241・#356。spec/flows.md 6.16・spec/api.md 7.2）
import { Microphone } from '@/audio/microphone';
import { AudioSender, connection } from '@/connection';
import type { JoinAvailability, ServerMessage } from '@/protocol';

// joining は返事（joined）待ち、reconnecting はホストとの接続が切れてつなぎ直すのを待っている間
export type Joined = { sessionId: string; source: number | null; state: 'joining' | 'joined' | 'reconnecting' };

export const UNSUPPORTED = 'このホストは参加に対応していません';

// 参加のボタンを押せないときの理由。押せるなら null
export function joinUnavailable(join: JoinAvailability | undefined): string | null {
    if (join === undefined) {
        return UNSUPPORTED;
    }
    if (join.available) {
        return null;
    }
    return join.reason === 'disabled' ? 'このホストでは参加できない設定です' : '参加できる音源の数に達しています';
}

// 参加している音源 ID と次の連番を、セッションごとにタブに覚える（読み込み直しても同じ音源としてつなぎ直す）
const KEY = 'rw-join:';

export function rememberJoin(sessionId: string, source: number, nextSeq: number) {
    try {
        sessionStorage.setItem(KEY + sessionId, JSON.stringify({ source, nextSeq }));
    } catch {
        // 保存できなくても参加は続ける（読み込み直したら新しい音源になるだけ）
    }
}

export function forgetJoin(sessionId: string) {
    try {
        sessionStorage.removeItem(KEY + sessionId);
    } catch {
        // 何もしない
    }
}

export function recalledJoin(sessionId: string): { source: number; nextSeq: number } | null {
    try {
        const raw = sessionStorage.getItem(KEY + sessionId);
        if (!raw) {
            return null;
        }
        const value = JSON.parse(raw) as { source?: unknown; nextSeq?: unknown };
        return typeof value.source === 'number' && typeof value.nextSeq === 'number'
            ? { source: value.source, nextSeq: value.nextSeq }
            : null;
    } catch {
        return null;
    }
}

// サーバーのログと音源の一覧に出す、端末の大まかな名前
export function deviceName(ua = navigator.userAgent): string {
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Macintosh/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    return 'ブラウザ';
}

type Processing = { noiseSuppression: boolean; autoGainControl: boolean; echoCancellation: boolean };

// 参加しているあいだのマイクと送信。録音しているクライアントと同じく、連番を付けて送り、ack まで手元に残す
export class SourceJoin {
    readonly sessionId: string;
    private source: number | null = null;
    private readonly sender: AudioSender;
    private mic: Microphone | null = null;
    private unsubscribe: (() => void) | null = null;
    private unwatchConnection: (() => void) | null = null;
    private resendAfterAck = false;
    private ended = false;
    private readonly onChange: (joined: Joined | null) => void;
    private readonly onEnd: (message: string | null) => void;

    // onChange は状態が変わったとき、onEnd は参加が終わったとき（message は知らせる理由。抜けた・録音が終わったときは null）
    constructor(sessionId: string, onChange: (joined: Joined | null) => void, onEnd: (message: string | null) => void) {
        this.sessionId = sessionId;
        this.onChange = onChange;
        this.onEnd = onEnd;
        this.sender = new AudioSender();
        // joined が届くまでは送らずに溜めておく
        this.sender.hold();
    }

    // マイクを開いて参加する。rejoin は読み込み直す前に参加していた音源（同じ音源としてつなぎ直す）
    async start(processing: Processing, rejoin: { source: number; nextSeq: number } | null) {
        this.mic = await Microphone.open((pcm) => this.sender.push(pcm), processing);
        if (this.ended) {
            this.mic.close();
            return;
        }
        this.unsubscribe = connection.subscribe((m) => this.receive(m));
        this.unwatchConnection = connection.onStateChange((connected) => {
            if (this.ended) {
                return;
            }
            if (!connected) {
                this.sender.hold();
                this.onChange({ sessionId: this.sessionId, source: this.source, state: 'reconnecting' });
            } else if (this.source !== null) {
                this.sendJoin({ source: this.source, nextSeq: this.sender.nextSeq });
            }
        });
        if (rejoin) {
            this.source = rejoin.source;
        }
        this.onChange({ sessionId: this.sessionId, source: this.source, state: 'joining' });
        this.sendJoin(
            rejoin ? { source: rejoin.source, nextSeq: Math.max(rejoin.nextSeq, this.sender.nextSeq) } : null,
        );
    }

    private sendJoin(rejoin: { source: number; nextSeq: number } | null) {
        if (rejoin) {
            this.resendAfterAck = true;
            connection.send({ type: 'join', session: this.sessionId, source: rejoin.source, nextSeq: rejoin.nextSeq });
        } else {
            connection.send({ type: 'join', session: this.sessionId, name: deviceName() });
        }
    }

    private receive(m: ServerMessage) {
        if (this.ended) {
            return;
        }
        if (m.type === 'joined' && m.session === this.sessionId) {
            this.source = m.source;
            rememberJoin(this.sessionId, m.source, this.sender.nextSeq);
            this.onChange({ sessionId: this.sessionId, source: m.source, state: 'joined' });
            if (!m.rejoined) {
                this.sender.resend();
            }
        } else if (m.type === 'ack' && m.session === this.sessionId) {
            this.sender.ack(m.seq);
            if (this.resendAfterAck) {
                // つなぎ直した直後の ack は、サーバーが受け取り済みの最後の連番。その次から送り直す
                this.resendAfterAck = false;
                this.sender.resend();
            }
            if (this.source !== null) {
                rememberJoin(this.sessionId, this.source, this.sender.nextSeq);
            }
        } else if (m.type === 'error' && this.source === null) {
            // 参加の返事を待っている間のエラー（古いサーバーは join を知らないので bad_message）
            if (m.code === 'bad_message') {
                this.finish(UNSUPPORTED);
            } else if (m.code === 'cannot_join' || m.code === 'session_not_found') {
                this.finish(m.message);
            }
        } else if (m.type === 'error' && this.resendAfterAck && m.code === 'session_not_found') {
            // つなぎ直せなかった（抜けたことになっていた）。もう一度参加し直してもらう
            this.finish('参加が切れました。もう一度参加してください');
        } else if (
            (m.type === 'recordingState' && m.session === this.sessionId && m.state === 'stopped') ||
            (m.type === 'watching' && m.session === this.sessionId && m.state === 'idle')
        ) {
            // 主の音源の録音が終わった。参加も終わる
            this.finish(null);
        }
    }

    // 抜ける（この端末で押したとき）
    leave() {
        if (!this.ended && connection.isOpen) {
            connection.send({ type: 'leave' });
        }
        this.finish(null);
    }

    private finish(message: string | null) {
        if (this.ended) {
            return;
        }
        this.ended = true;
        forgetJoin(this.sessionId);
        this.mic?.close();
        this.unsubscribe?.();
        this.unwatchConnection?.();
        this.onChange(null);
        this.onEnd(message);
    }
}
