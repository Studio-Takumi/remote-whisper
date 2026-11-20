// iOS アプリ（#438。spec/mobile.md 11.4）の中で開いているかを見分ける。
// ブラウザ版の最初のチャンクに @capacitor/core を入れないため、ここでは読み込まない。
// アプリの中では、Capacitor が画面の読み込み前に window.Capacitor を差し込むので、それだけを見る
import type { AppStore } from '@/app/appState';
import type { RecorderPlugin } from '@/features/native/recorderTypes';

type CapacitorGlobal = { isNativePlatform?: () => boolean };

export function isNativeApp(): boolean {
    const capacitor = (window as { Capacitor?: CapacitorGlobal }).Capacitor;
    return capacitor?.isNativePlatform?.() === true;
}

// 設定モーダルの、アプリの中でだけ出すページ（URL は /settings/ios）。ブラウザ版のページの並びは変えず、最後に足す
export const NATIVE_SETTINGS_PAGE = 'ios';

// ネイティブを呼ぶコード（別のチャンク）。アプリの中でだけ読み込む
const loadBridge = () => import('@/features/native/nativeBridge');

// アプリの中で開いたときだけ、<html> に rw-native を付ける（safe area の余白は index.css の .rw-native の下だけで当てる）
// ほか、ステータスバーの文字の色を合わせる
export function startNativeShell() {
    if (!isNativeApp()) {
        return;
    }
    document.documentElement.classList.add('rw-native');
    void loadBridge().then((m) => m.startNativeShell());
}

// 録音の状態をロック画面の Live Activity とダイナミックアイランドに出す（#453）。ブラウザ版では何もしない
export function startLiveActivity(store: AppStore) {
    if (!isNativeApp()) {
        return;
    }
    void loadBridge().then((m) => m.startLiveActivity(store));
}

// ウィジェット・App Intents から開いたときに、録音を始める・セッションを開く（#454）。ブラウザ版では何もしない
export function startAppEntry(store: AppStore) {
    if (!isNativeApp()) {
        return;
    }
    void loadBridge().then((m) => m.startAppEntry(store));
}

// 録音のプラグイン。プラグインは Proxy で、Promise の結果にそのまま渡せないので、包んで返す
export async function loadRecorder(): Promise<{ plugin: RecorderPlugin }> {
    const { Recorder } = await loadBridge();
    return { plugin: Recorder };
}
