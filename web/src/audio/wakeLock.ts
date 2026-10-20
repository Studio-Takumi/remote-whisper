// 録音中に画面がスリープしないようにする（Screen Wake Lock API。spec/flows.md 6.7、#102）
// タブを裏に回すとブラウザが外すので、表に戻ったら取り直す。使えないブラウザでは何もしない

let wanted = false;
let sentinel: WakeLockSentinel | null = null;
let listening = false;

async function acquire() {
    if (!wanted || sentinel || document.visibilityState !== 'visible' || !('wakeLock' in navigator)) {
        return;
    }
    try {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
            sentinel = null;
        });
        // 取っている間に外すよう頼まれていたら、すぐ外す
        if (!wanted) {
            void release();
        }
    } catch {
        // 省電力モードなどで断られた。録音は続ける
        sentinel = null;
    }
}

async function release() {
    const current = sentinel;
    sentinel = null;
    try {
        await current?.release();
    } catch {
        // すでに外れている
    }
}

// 録音を始めたら true、終えたら false
export function keepScreenOn(on: boolean) {
    wanted = on;
    if (!listening) {
        listening = true;
        document.addEventListener('visibilitychange', () => void acquire());
    }
    void (on ? acquire() : release());
}

// 今、画面のスリープを止めているか（開発用・確かめるため）
export function screenKeptOn() {
    return sentinel !== null;
}
