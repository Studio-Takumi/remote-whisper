// マイクの音声を AudioWorklet で 16kHz・モノラル・Int16 の PCM にする（spec 7.2）

// AudioWorklet の本体は public/ に置き、ビルドでもそのままの名前で配信する（data URL に埋め込まれないように）
const workletUrl = `${import.meta.env.BASE_URL}pcm-worklet.js`;

export type PcmHandler = (pcm: Int16Array, level: number) => void;

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

    private constructor(stream: MediaStream, context: AudioContext) {
        this.stream = stream;
        this.context = context;
    }

    static async open(onPcm: PcmHandler): Promise<Microphone> {
        if (!navigator.mediaDevices?.getUserMedia) {
            // getUserMedia は安全なコンテキスト（HTTPS か localhost）でしか使えない
            throw new MicrophoneError('unavailable', 'このページではマイクを使えません（HTTPS で開いてください）');
        }
        let stream: MediaStream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
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
            node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; level: number }>) =>
                onPcm(e.data.pcm, e.data.level);
            source.connect(node);
        } catch (e) {
            stream.getTracks().forEach((t) => t.stop());
            await context.close();
            throw new MicrophoneError('unavailable', `音声の処理を始められません: ${(e as Error).message}`);
        }
        return new Microphone(stream, context);
    }

    close() {
        this.stream.getTracks().forEach((t) => t.stop());
        void this.context.close();
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
