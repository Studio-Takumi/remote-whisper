// iOS アプリの Live Activity のプラグイン（LiveActivity。#453）の、JS 向けの型。正本は spec/mobile.md 11.5
import type { PluginListenerHandle } from '@capacitor/core';

export type LiveActivityState = 'recording' | 'paused';

// Live Activity に出すもの。elapsed は経過時間（秒）、lines は直近のリアルタイム文字起こし（古い順）
export type LiveActivityContent = {
    state: LiveActivityState;
    elapsed: number;
    title: string;
    lines: string[];
};

// ボタン（一時停止・再開・終了）が押された
export type LiveActivityAction = 'pause' | 'resume' | 'stop';

export type LiveActivityPlugin = {
    // shown は出せたか（iOS 16.1 より前・設定で許可されていないときは false）
    start(options: LiveActivityContent & { sessionId: string }): Promise<{ shown: boolean }>;
    update(options: LiveActivityContent): Promise<{ shown: boolean }>;
    end(): Promise<void>;
    addListener(
        event: 'action',
        listener: (event: { action: LiveActivityAction }) => void,
    ): Promise<PluginListenerHandle>;
};
