// iOS アプリ（#438。spec/mobile.md 11.4）の中で開いたときだけ読み込むチャンク。ネイティブを呼ぶコード（@capacitor/core）は
// ここにだけ置き、nativePlatform.ts から dynamic import で読み込む。ブラウザ版では読み込まない。
// React の部品はここに置かない（lazy の部品のチャンクを足すと、ビルドが共通のランタイムを別のチャンクに分け、
// ブラウザ版の最初に読むファイルが 1 つ増えるため）
import { SystemBars, SystemBarsStyle, registerPlugin } from '@capacitor/core';

import type { AppStore } from '@/app/appState';
import { LiveActivitySync } from '@/features/native/liveActivitySync';
import type { LiveActivityPlugin } from '@/features/native/liveActivityTypes';
import type { RecorderPlugin } from '@/features/native/recorderTypes';

// 録音のプラグイン（mobile/ios/App/App/Recorder/。MainViewController が登録する）。
// Proxy なので、Promise の結果にそのまま渡さない（then を呼ばれてネイティブのメソッドとして扱われる）
export const Recorder = registerPlugin<RecorderPlugin>('Recorder');

// Live Activity のプラグイン（mobile/ios/App/App/LiveActivity/。#453）
const LiveActivity = registerPlugin<LiveActivityPlugin>('LiveActivity');

// 録音の状態を Live Activity に出し、そのボタンの操作を受け取り始める（spec/mobile.md 11.5）
export function startLiveActivity(store: AppStore) {
    new LiveActivitySync(store, LiveActivity).start();
}

// env(safe-area-inset-*) は viewport-fit=cover のときだけ値が入る。index.html の meta に付いているが、
// 付いていなければ足す（ブラウザ版の meta は変えない）
function ensureViewportFitCover() {
    const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (meta && !meta.content.includes('viewport-fit=cover')) {
        meta.content = `${meta.content}, viewport-fit=cover`;
    }
}

// ステータスバーの文字の色を、画面のテーマ（<html> の .dark）に合わせる。
// 既定は端末の外観に合わせるので、画面だけダークにしたときなどに文字が背景に溶ける
function followTheme() {
    const root = document.documentElement;
    let dark: boolean | null = null;
    const apply = () => {
        const next = root.classList.contains('dark');
        if (next !== dark) {
            dark = next;
            void SystemBars.setStyle({ style: next ? SystemBarsStyle.Dark : SystemBarsStyle.Light });
        }
    };
    apply();
    new MutationObserver(apply).observe(root, { attributes: true, attributeFilter: ['class'] });
}

export function startNativeShell() {
    ensureViewportFitCover();
    followTheme();
}
