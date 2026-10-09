// AudioWorklet。マイクの音声を 16kHz・モノラル・Int16 の PCM にして、メインスレッドに送る（spec 7.2）
// AudioContext のサンプルレート（48kHz など）から 16kHz へは、線形補間で間引く

const TARGET_RATE = 16000;
// これだけ溜まったら送る（16kHz で約 0.1 秒）。0.5 秒ごとのチャンクにまとめるのはメインスレッド側
const POST_SAMPLES = 1600;

class PcmProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // sampleRate は AudioWorkletGlobalScope のグローバル
        this.step = sampleRate / TARGET_RATE;
        this.pos = 0; // 次に取り出す位置（入力のサンプル単位。前のブロックの最後のサンプルが -1）
        this.last = 0; // 前のブロックの最後のサンプル
        this.out = new Int16Array(POST_SAMPLES);
        this.length = 0;
        this.sumSquares = 0;
    }

    process(inputs) {
        const channels = inputs[0];
        if (!channels || channels.length === 0) {
            return true;
        }
        // 複数チャンネルなら平均してモノラルにする
        const n = channels[0].length;
        const mono = new Float32Array(n);
        for (const ch of channels) {
            for (let i = 0; i < n; i++) {
                mono[i] += ch[i] / channels.length;
            }
        }

        while (this.pos < n - 1) {
            const i = Math.floor(this.pos);
            const frac = this.pos - i;
            const a = i < 0 ? this.last : mono[i];
            const b = mono[i + 1];
            const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
            this.sumSquares += v * v;
            this.out[this.length++] = v < 0 ? v * 0x8000 : v * 0x7fff;
            if (this.length === POST_SAMPLES) {
                this.flush();
            }
            this.pos += this.step;
        }
        this.pos -= n;
        this.last = mono[n - 1];
        return true;
    }

    flush() {
        const pcm = this.out.slice(0, this.length);
        // 音量（RMS）。ボタンのアニメーションに使う
        const level = Math.sqrt(this.sumSquares / this.length);
        this.port.postMessage({ pcm, level }, [pcm.buffer]);
        this.length = 0;
        this.sumSquares = 0;
    }
}

registerProcessor('pcm-processor', PcmProcessor);
