// iOS アプリの録音のプラグイン（Recorder）の、JS 向けの型。正本は spec/mobile.md 11.3
import type { PluginListenerHandle } from '@capacitor/core';

export type RecorderState = 'idle' | 'recording' | 'interrupted';

// 状態が変わった理由（spec/mobile.md 11.3 の「状態と止まる理由」）
export type RecorderReason =
    'user' | 'interruption' | 'resumed' | 'interruptionEnded' | 'routeChange' | 'mediaServicesReset' | 'error';

// 失敗したときの code
export type RecorderErrorCode =
    | 'permission-denied'
    | 'already-recording'
    | 'not-recording'
    | 'no-input'
    | 'invalid-name'
    | 'invalid-argument'
    | 'not-found'
    | 'busy'
    | 'io';

export type RecordingFile = {
    name: string;
    durationSec: number;
    // バイト
    size: number;
    // ISO 8601
    createdAt: string;
    modifiedAt: string;
};

export type RecorderStatus = { state: RecorderState; file?: string; seconds: number };

export type StateChangeEvent = { state: RecorderState; reason: RecorderReason; file?: RecordingFile };

export type ProgressEvent = { seconds: number };

// readRecording の 1 回の結果。data は base64、size はファイル全体のバイト数
export type RecordingChunk = { data: string; offset: number; size: number };

export interface RecorderPlugin {
    start(): Promise<{ file: string }>;
    stop(): Promise<{ file: RecordingFile }>;
    getStatus(): Promise<RecorderStatus>;
    listRecordings(): Promise<{ files: RecordingFile[] }>;
    // length の既定・上限は 4MiB
    readRecording(options: { name: string; offset?: number; length?: number }): Promise<RecordingChunk>;
    deleteRecording(options: { name: string }): Promise<void>;
    addListener(eventName: 'stateChange', listener: (event: StateChangeEvent) => void): Promise<PluginListenerHandle>;
    addListener(eventName: 'progress', listener: (event: ProgressEvent) => void): Promise<PluginListenerHandle>;
}
