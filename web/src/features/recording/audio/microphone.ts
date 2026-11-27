// マイクの音声を AudioWorklet で 16kHz・モノラル・Int16 の PCM にする（spec/api.md 7.2）
import { recordingMessages } from '@/features/recording/i18n';

// AudioWorklet の本体は public/ に置き、ビルドでもそのままの名前で配信する（data URL に埋め込まれないように）
const workletUrl = `${import.meta.env.BASE_URL}pcm-worklet.js`;

// worklet が出す PCM のサンプリング周波数（pcm-worklet.js の TARGET_RATE と同じ）
export const SAMPLE_RATE = 16000;

export type PcmHandler = (pcm: Int16Array, level: number) => void;

// マイクの状態（#102）。ended はトラックが止まった（ほかのアプリに取られた・抜かれたなど）、
// muted は音が来ていない（OS やほかのアプリが止めている）、suspended は音声の処理が止まった（電話が来たなど）
export type MicState = 'ok' | 'muted' | 'ended' | 'suspended';

// ブラウザのマイクの処理（getUserMedia の制約。全体設定の recording.noiseSuppression・autoGainControl・echoCancellation）
export type Processing = { noiseSuppression: boolean; autoGainControl: boolean; echoCancellation: boolean };

// マイクが使えないときのエラー。denied はユーザーかブラウザが許可しなかったもの、
// missing は指定したマイク（deviceId）が見つからないもの（#449）
export type MicrophoneErrorReason = 'denied' | 'unavailable' | 'missing';

export class MicrophoneError extends Error {
    readonly reason: MicrophoneErrorReason;

    constructor(reason: MicrophoneErrorReason, message: string) {
        super(message);
        this.reason = reason;
    }
}

export class Microphone {
    private readonly stream: MediaStream;
    private readonly context: AudioContext;
    private readonly source: MediaStreamAudioSourceNode;
    private readonly node: AudioWorkletNode;
    // flush の返事（'flushed'）を待っているもの
    private readonly flushing: (() => void)[] = [];
    private closed = false;

    private constructor(
        stream: MediaStream,
        context: AudioContext,
        source: MediaStreamAudioSourceNode,
        node: AudioWorkletNode,
        onPcm: PcmHandler,
    ) {
        this.stream = stream;
        this.context = context;
        this.source = source;
        this.node = node;
        node.port.onmessage = (e: MessageEvent<'flushed' | { pcm: Int16Array; level: number }>) => {
            if (e.data === 'flushed') {
                this.flushing.shift()?.();
            } else {
                onPcm(e.data.pcm, e.data.level);
            }
        };
    }

    // worklet に溜まっている分（最大 0.1 秒）を送らせる。届いたら resolve する（一時停止・終了の前に呼ぶ）
    flush(): Promise<void> {
        return new Promise((resolve) => {
            this.flushing.push(resolve);
            this.node.port.postMessage('flush');
        });
    }

    // worklet に溜まっている分を捨てる（一時停止から再開するとき。一時停止中の音を送らないため）
    discard() {
        this.node.port.postMessage('discard');
    }

    // processing はブラウザのマイクの処理
    // onState は、マイクが止まったり戻ったりしたときに呼ぶ（録音が知らないうちに止まらないよう、画面で知らせる）
    // deviceId は選んだマイク（#449）。ないときは OS に任せる（deviceId を渡さない）
    static async open(
        onPcm: PcmHandler,
        processing: Processing,
        onState: (state: MicState) => void = () => {},
        deviceId?: string,
    ): Promise<Microphone> {
        if (!navigator.mediaDevices?.getUserMedia) {
            // getUserMedia は安全なコンテキスト（HTTPS か localhost）でしか使えない
            throw new MicrophoneError('unavailable', recordingMessages.t('microphone.insecure'));
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, ...processing, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
            });
        } catch (e) {
            if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
                throw new MicrophoneError('denied', recordingMessages.t('microphone.denied'));
            }
            // 指定したマイクがない（外した・ID が変わった）とき。OverconstrainedError は DOMException でないブラウザがある
            const name = (e as { name?: string } | null)?.name;
            if (deviceId && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
                throw new MicrophoneError('missing', recordingMessages.t('microphone.missing'));
            }
            throw new MicrophoneError(
                'unavailable',
                recordingMessages.t('microphone.openFailed', { message: (e as Error).message }),
            );
        }
        const context = new AudioContext();
        try {
            await context.audioWorklet.addModule(workletUrl);
            const source = context.createMediaStreamSource(stream);
            const node = new AudioWorkletNode(context, 'pcm-processor');
            const mic = new Microphone(stream, context, source, node, onPcm);
            source.connect(node);
            // Safari などでは、AudioContext が止まった状態（suspended）で作られることがある
            await context.resume();
            mic.watch(onState);
            return mic;
        } catch (e) {
            stream.getTracks().forEach((t) => t.stop());
            await context.close();
            throw new MicrophoneError(
                'unavailable',
                recordingMessages.t('microphone.processingFailed', { message: (e as Error).message }),
            );
        }
    }

    // 今のマイクの状態
    state(): MicState {
        const track = this.stream.getAudioTracks()[0];
        if (!track || track.readyState === 'ended') {
            return 'ended';
        }
        if (track.muted) {
            return 'muted';
        }
        // iOS の Safari は、割り込み（電話・Siri など）の間 'interrupted' になる
        return this.context.state === 'running' ? 'ok' : 'suspended';
    }

    // 開いているマイクの名前（#449。開き直したときに、どのマイクで録っているかを知らせる）
    label(): string {
        return this.stream.getAudioTracks()[0]?.label ?? '';
    }

    // トラックと音声の処理を見張る（#102）。実機でどのイベントが来るかを Web インスペクタで見られるよう、ログに出す（#447）
    private watch(onState: (state: MicState) => void) {
        const track = this.stream.getAudioTracks()[0];
        const report = (e?: Event) => {
            if (this.closed) {
                return;
            }
            const state = this.state();
            console.info(
                `[Mic] ${e ? e.type : 'open'}: track=${track?.readyState ?? 'none'}${track?.muted ? '(muted)' : ''} context=${this.context.state} -> ${state}`,
            );
            onState(state);
        };
        track?.addEventListener('ended', report);
        track?.addEventListener('mute', report);
        track?.addEventListener('unmute', report);
        this.context.addEventListener('statechange', report);
        report();
    }

    // 止まった音声の処理を動かし直す（suspended から戻すとき）
    async restart() {
        await this.context.resume();
    }

    close() {
        this.closed = true;
        this.node.port.onmessage = null;
        this.source.disconnect();
        this.stream.getTracks().forEach((t) => t.stop());
        void this.context.close();
        // 待っている flush があれば終わらせる
        this.flushing.splice(0).forEach((resolve) => resolve());
    }
}

// マイクの許可の状態を見張る。Permissions API がないブラウザでは何もしない
export async function watchMicrophonePermission(onChange: (denied: boolean) => void) {
    try {
        const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        onChange(status.state === 'denied');
        status.onchange = () => onChange(status.state === 'denied');
    } catch {
        // Firefox などは microphone を問い合わせられない。getUserMedia の失敗で判定する
    }
}
