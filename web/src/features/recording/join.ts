// 録音中のセッションに、この端末のマイクを音源として参加する（#241・#356。spec/flows.md 6.16・spec/api.md 7.2）
import { AudioSender, connection } from '@/api/connection';
import type { JoinAvailability, ServerMessage } from '@/api/protocol';
import { type ChosenMic, openChosenMicrophone } from '@/features/recording/audio/micDevice';
import type { Microphone, Processing } from '@/features/recording/audio/microphone';
import { recordingMessages } from '@/features/recording/i18n';

// joining は返事（joined）待ち、reconnecting はホストとの接続が切れてつなぎ直すのを待っている間
export type Joined = { sessionId: string; source: number | null; state: 'joining' | 'joined' | 'reconnecting' };

export function unsupportedMessage() {
    return recordingMessages.t('join.unsupported');
}

// 参加のボタンを押せないときの理由。押せるなら null
export function joinUnavailable(join: JoinAvailability | undefined): string | null {
    if (join === undefined) {
        return unsupportedMessage();
    }
    if (join.available) {
        return null;
    }
    return join.reason === 'disabled' ? recordingMessages.t('join.disabled') : recordingMessages.t('join.full');
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

// 参加しているあいだのマイクと送信。録音しているクライアントと同じく、連番を付けて送り、ack まで手元に残す
export class SourceJoin {
    readonly sessionId: string;
    private source: number | null = null;
    private readonly sender: AudioSender;
    private mic: Microphone | null = null;
    private unsubscribe: (() => void) | null = null;
    private unwatchConnection: (() => void) | null = null;
    private resendAfterAck = false;
    // join を送って、返事（joined）を待っている
    private awaiting = false;
    private ended = false;
    private readonly onChange: (joined: Joined | null) => void;
    private readonly onEnd: (message: string | null) => void;
    private readonly onLevel: (level: number) => void;

    // onChange は状態が変わったとき、onEnd は参加が終わったとき（message は知らせる理由。抜けた・録音が終わったときは null）。
    // onLevel はマイクの音量（RMS、0〜1。#357）
    constructor(
        sessionId: string,
        onChange: (joined: Joined | null) => void,
        onEnd: (message: string | null) => void,
        onLevel: (level: number) => void = () => {},
    ) {
        this.sessionId = sessionId;
        this.onChange = onChange;
        this.onEnd = onEnd;
        this.onLevel = onLevel;
        this.sender = new AudioSender();
        // joined が届くまでは送らずに溜めておく
        this.sender.hold();
    }

    // マイクを開いて参加する。rejoin は読み込み直す前に参加していた音源（同じ音源としてつなぎ直す）。
    // マイクは設定で選んだもの（#449）。ないときは OS に任せて開き、onFallback で知らせる
    async start(
        processing: Processing,
        rejoin: { source: number; nextSeq: number } | null,
        onFallback: (chosen: ChosenMic) => void = () => {},
    ) {
        if (rejoin) {
            // 読み込み直す前の続きの連番から振る（0 から振ると、サーバーが受け取り済みとみなして捨てる）
            this.sender.startFrom(rejoin.nextSeq);
        }
        this.mic = await openChosenMicrophone(
            (pcm, level) => {
                this.sender.push(pcm);
                this.onLevel(level);
            },
            processing,
            () => {},
            onFallback,
        );
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
        // 読み込み直したときは手元の音をなくしているので lost を付ける（サーバーが届かなかった間を無音で埋める）
        this.sendJoin(rejoin ? { source: rejoin.source, nextSeq: rejoin.nextSeq, lost: true } : null);
    }

    private sendJoin(rejoin: { source: number; nextSeq: number; lost?: boolean } | null) {
        this.awaiting = true;
        if (rejoin) {
            this.resendAfterAck = true;
            connection.send({
                type: 'join',
                session: this.sessionId,
                source: rejoin.source,
                nextSeq: rejoin.nextSeq,
                ...(rejoin.lost ? { lost: true } : {}),
            });
        } else {
            connection.send({ type: 'join', session: this.sessionId, name: deviceName() });
        }
    }

    private receive(m: ServerMessage) {
        if (this.ended) {
            return;
        }
        if (m.type === 'joined' && m.session === this.sessionId) {
            this.awaiting = false;
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
        } else if (m.type === 'error' && this.awaiting) {
            // 参加・つなぎ直しの返事を待っている間のエラーだけを見る（ほかのエラーで参加を終えない）
            const rejoining = this.source !== null;
            if (m.code === 'bad_message' && !rejoining) {
                // 古いサーバーは join を知らない
                this.finish(unsupportedMessage());
            } else if (m.code === 'cannot_join' || m.code === 'session_not_found' || m.code === 'bad_message') {
                // つなぎ直せなかった（抜けたことになっていた・録音が終わっていた）ときは、参加し直してもらう
                this.finish(rejoining ? recordingMessages.t('join.lost') : m.message);
            }
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
