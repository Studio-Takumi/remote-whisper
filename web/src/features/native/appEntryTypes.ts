// iOS アプリの、ウィジェット・App Intents から開いたときの頼みごとのプラグイン（AppEntry。#454）の、JS 向けの型。
// 正本は spec/mobile.md 11.6
import type { PluginListenerHandle } from '@capacitor/core';

// record は録音を始める（ホーム画面のウィジェットの待機中・ショートカット・Siri・コントロールセンター）。
// session はそのセッションを開く（ホーム画面のウィジェットの録音中）
export type AppEntryRequest = { kind: 'record' } | { kind: 'session'; sessionId: string };

export type AppEntryPlugin = {
    addListener(event: 'entry', listener: (request: AppEntryRequest) => void): Promise<PluginListenerHandle>;
};
