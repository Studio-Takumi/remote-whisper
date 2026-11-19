// 割り込み（Siri・ほかのアプリの音の再生・電話など）でマイクが止まったあと、自動で録音に戻す（#447・spec/flows.md 6.7）
import type { MicState } from '@/features/recording/audio/microphone';

// 止まってから試すまでの間（ミリ秒）。割り込みの最中に開き直すと Siri などを邪魔するので、少し待ってから試す。
// 全部だめなら、前面に戻ったときまで待つ（警告と「マイクを開き直す」は出たまま）
export const RETRY_DELAYS = [3000, 10000, 30000];

// 割り込みの間、AudioContext.resume() は終わるまで返らないことがあるので、待つのはここまで
const RESUME_TIMEOUT = 1000;

export type MicRecoveryTarget = {
    // 自動で戻してよいか（録音中だけ。ユーザーが一時停止している間・録音を終えたあとは戻さない）
    active: () => boolean;
    state: () => MicState;
    // 音声の処理を動かし直す（AudioContext.resume）
    resume: () => Promise<void>;
    // マイクを開き直す（getUserMedia から作り直し、同じセッションのまま送り続ける）
    reopen: () => Promise<void>;
    // 自動で戻れたとき
    recovered: () => void;
};

export class MicRecovery {
    private readonly target: MicRecoveryTarget;
    // 今の止まりで、何回試したか（戻ったら 0 に戻す）
    private attempts = 0;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private listening = false;

    constructor(target: MicRecoveryTarget) {
        this.target = target;
    }

    // 前面に戻ったときは、待たずに試し直す
    private readonly onForeground = (e: Event) => {
        if (document.visibilityState === 'visible') {
            void this.retryNow(e.type);
        }
    };

    // マイクを開いたら、前面に戻ったことを見張る
    start() {
        if (this.listening) {
            return;
        }
        this.listening = true;
        document.addEventListener('visibilitychange', this.onForeground);
        window.addEventListener('pageshow', this.onForeground);
        window.addEventListener('focus', this.onForeground);
    }

    // マイクを閉じたら、見張るのをやめる
    stop() {
        this.listening = false;
        document.removeEventListener('visibilitychange', this.onForeground);
        window.removeEventListener('pageshow', this.onForeground);
        window.removeEventListener('focus', this.onForeground);
        this.cancel();
        this.attempts = 0;
    }

    // マイクの状態が変わったとき。止まったら、少し待ってから戻すのを試す
    changed(state: MicState) {
        if (state === 'ok') {
            this.cancel();
            this.attempts = 0;
        } else if (this.listening && !this.running && !this.timer) {
            this.schedule();
        }
    }

    // 回数を数え直して、すぐ試す（前面に戻った・一時停止から再開したとき）
    retryNow(reason: string) {
        this.attempts = 0;
        return this.attempt(reason);
    }

    private cancel() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule() {
        if (this.attempts >= RETRY_DELAYS.length) {
            console.info('[Mic] auto recovery: gave up until the page comes back to the foreground');
            return;
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.attempt('retry');
        }, RETRY_DELAYS[this.attempts]);
    }

    private async attempt(reason: string) {
        this.cancel();
        if (this.running || !this.target.active() || this.target.state() === 'ok') {
            return;
        }
        // 裏にいる間は開き直さない（前面で使っているほかのアプリの音を止めないため）。前面に戻ったら試す
        if (document.visibilityState !== 'visible') {
            console.info(`[Mic] auto recovery (${reason}): waiting for the foreground`);
            return;
        }
        this.attempts += 1;
        this.running = true;
        console.info(`[Mic] auto recovery (${reason}) #${this.attempts}: ${this.target.state()}`);
        try {
            if (this.target.state() === 'suspended') {
                await Promise.race([this.target.resume(), sleep(RESUME_TIMEOUT)]);
            }
            if (this.target.active() && this.target.state() !== 'ok') {
                await this.target.reopen();
            }
        } catch (e) {
            console.info(`[Mic] auto recovery failed: ${(e as Error).message}`);
        } finally {
            this.running = false;
        }
        if (!this.target.active()) {
            return;
        }
        const state = this.target.state();
        console.info(`[Mic] auto recovery result: ${state}`);
        if (state === 'ok') {
            this.attempts = 0;
            this.target.recovered();
        } else if (this.listening) {
            this.schedule();
        }
    }
}

function sleep(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
