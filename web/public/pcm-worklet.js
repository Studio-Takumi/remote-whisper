// AudioWorklet。マイクの音声を 16kHz・モノラル・Int16 の PCM にして、メインスレッドに送る（spec 7.2）
// AudioContext のサンプルレート（48kHz など）から 16kHz へは、ローパスをかけてから線形補間で間引く
//
// メインスレッドからのメッセージ:
//   'flush'   … 溜まっている分を半端でも送り、続けて 'flushed' を返す（一時停止・終了の前）
//   'discard' … 溜まっている分を捨てる（一時停止から再開するとき。一時停止中の音を送らないため）

const TARGET_RATE = 16000;
// これだけ溜まったら送る（16kHz で約 0.1 秒）。0.5 秒ごとのチャンクにまとめるのはメインスレッド側
const POST_SAMPLES = 1600;
// ローパスのタップ数（奇数）とカットオフ。16kHz のナイキスト周波数（8kHz）より少し下で切る
const TAPS = 63;
const CUTOFF_HZ = 7200;

// Blackman 窓をかけた sinc のローパス。係数の合計を 1 にそろえる
function lowpass(cutoff, taps) {
    const h = new Float32Array(taps);
    const m = taps - 1;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
        const x = i - m / 2;
        const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
        const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / m) + 0.08 * Math.cos((4 * Math.PI * i) / m);
        h[i] = sinc * w;
        sum += h[i];
    }
    for (let i = 0; i < taps; i++) {
        h[i] /= sum;
    }
    return h;
}

class PcmProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // sampleRate は AudioWorkletGlobalScope のグローバル
        this.step = sampleRate / TARGET_RATE;
        // 入力が 16kHz 以下なら、ローパスはかけない（間引かないので折り返しが起きない）
        this.taps = this.step > 1 ? lowpass(CUTOFF_HZ / sampleRate, TAPS) : new Float32Array([1]);
        // [前のブロックの最後の taps-1 サンプル][今のブロック]。オーディオスレッドで GC を起こさないよう使い回す
        this.input = new Float32Array(this.taps.length - 1 + 128);
        this.filtered = new Float32Array(128);
        this.pos = 0; // 次に取り出す位置（filtered の添え字。前のブロックの最後のサンプルが -1）
        this.last = 0; // 前のブロックの最後のサンプル（ローパス後）
        this.out = new Int16Array(POST_SAMPLES);
        this.length = 0;
        this.sumSquares = 0;
        this.port.onmessage = (e) => {
            if (e.data === 'flush') {
                this.flush();
                this.port.postMessage('flushed');
            } else if (e.data === 'discard') {
                this.length = 0;
                this.sumSquares = 0;
            }
        };
    }

    process(inputs) {
        const channels = inputs[0];
        if (!channels || channels.length === 0) {
            return true;
        }
        const n = channels[0].length;
        const k = this.taps.length;
        if (this.input.length < k - 1 + n) {
            const grown = new Float32Array(k - 1 + n);
            grown.set(this.input.subarray(0, k - 1));
            this.input = grown;
            this.filtered = new Float32Array(n);
        }

        // 複数チャンネルなら平均してモノラルにする
        const input = this.input;
        for (let i = 0; i < n; i++) {
            let v = 0;
            for (const ch of channels) {
                v += ch[i];
            }
            input[k - 1 + i] = v / channels.length;
        }
        // ローパス（FIR）
        const filtered = this.filtered;
        for (let i = 0; i < n; i++) {
            let acc = 0;
            for (let j = 0; j < k; j++) {
                acc += this.taps[j] * input[i + j];
            }
            filtered[i] = acc;
        }
        // 次のブロックのために、最後の taps-1 サンプルを先頭へ移す
        input.copyWithin(0, n, n + k - 1);

        // 線形補間で 16kHz の位置の値を取り出す
        while (this.pos < n - 1) {
            const i = Math.floor(this.pos);
            const frac = this.pos - i;
            const a = i < 0 ? this.last : filtered[i];
            const b = filtered[i + 1];
            const v = Math.max(-1, Math.min(1, a + (b - a) * frac));
            this.sumSquares += v * v;
            this.out[this.length++] = v < 0 ? v * 0x8000 : v * 0x7fff;
            if (this.length === POST_SAMPLES) {
                this.flush();
            }
            this.pos += this.step;
        }
        this.pos -= n;
        this.last = filtered[n - 1];
        return true;
    }

    flush() {
        if (this.length === 0) {
            return;
        }
        const pcm = this.out.slice(0, this.length);
        // 音量（RMS）。ボタンのアニメーションに使う
        const level = Math.sqrt(this.sumSquares / this.length);
        this.port.postMessage({ pcm, level }, [pcm.buffer]);
        this.length = 0;
        this.sumSquares = 0;
    }
}

registerProcessor('pcm-processor', PcmProcessor);
