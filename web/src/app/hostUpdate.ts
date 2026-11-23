// ホストの新しい版（#472）のトーストを、どの版まで出したか（localStorage）。同じ版ではもう出さない
export const NOTIFIED_KEY = 'rw.hostUpdate.notified';

// localStorage が使えないとき（プライベートブラウズなど）は、開いている間だけ覚える
let notifiedInMemory: string | null = null;

export function alreadyNotified(version: string): boolean {
    try {
        if (localStorage.getItem(NOTIFIED_KEY) === version) {
            return true;
        }
    } catch {
        // 読めなければ、開いている間の分だけを見る
    }
    return notifiedInMemory === version;
}

export function rememberNotified(version: string) {
    notifiedInMemory = version;
    try {
        localStorage.setItem(NOTIFIED_KEY, version);
    } catch {
        // 覚えられなくても、開いている間は出さない
    }
}
