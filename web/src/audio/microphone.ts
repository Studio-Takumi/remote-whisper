// マイクの音声を AudioWorklet で 16kHz・モノラル・Int16 の PCM にする（spec/api.md 7.2）

// AudioWorklet の本体は public/ に置き、ビルドでもそのままの名前で配信する（data URL に埋め込まれないように）
const workletUrl = `${import.meta.env.BASE_URL}pcm-worklet.js`;

// worklet が出す PCM のサンプリング周波数（pcm-worklet.js の TARGET_RATE と同じ）
export const SAMPLE_RATE = 16000;

export type PcmHandler = (pcm: Int16Array, level: number) => void;

// マイクの状態（#102）。ended はトラックが止まった（ほかのアプリに取られた・抜かれたなど）、
// muted は音が来ていない（OS やほかのアプリが止めている）、suspended は音声の処理が止まった（電話が来たなど）
export type MicState = 'ok' | 'muted' | 'ended' | 'suspended';

// マイクが使えないときのエラー。denied はユーザーかブラウザが許可しなかったもの
export class MicrophoneError extends Error {
    readonly reason: 'denied' | 'unavailable';

    constructor(reason: 'denied' | 'unavailable', message: string) {
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

    // processing はブラウザのマイクの処理（全体設定の recording.noiseSuppression・autoGainControl・echoCancellation）
    // onState は、マイクが止まったり戻ったりしたときに呼ぶ（録音が知らないうちに止まらないよう、画面で知らせる）
    static async open(
        onPcm: PcmHandler,
        processing: { noiseSuppression: boolean; autoGainControl: boolean; echoCancellation: boolean },
        onState: (state: MicState) => void = () => {},
    ): Promise<Microphone> {
        if (!navigator.mediaDevices?.getUserMedia) {
            // getUserMedia は安全なコンテキスト（HTTPS か localhost）でしか使えない
            throw new MicrophoneError('unavailable', 'このページではマイクを使えません（HTTPS で開いてください）');
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, ...processing },
            });
        } catch (e) {
            if (e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) {
                throw new MicrophoneError('denied', 'マイクの使用が許可されていません');
            }
            throw new MicrophoneError('unavailable', `マイクを開けません: ${(e as Error).message}`);
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
            throw new MicrophoneError('unavailable', `音声の処理を始められません: ${(e as Error).message}`);
        }
    }

    // トラックと音声の処理を見張る（#102）
    private watch(onState: (state: MicState) => void) {
        const track = this.stream.getAudioTracks()[0];
        const report = () => {
            if (this.closed) {
                return;
            }
            if (!track || track.readyState === 'ended') {
                onState('ended');
            } else if (track.muted) {
                onState('muted');
            } else if (this.context.state !== 'running') {
                onState('suspended');
            } else {
                onState('ok');
            }
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
