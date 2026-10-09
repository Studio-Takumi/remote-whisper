// 録音の状態。一時停止中も録音のセッションは続いているので、設定のロックなどは録音中と同じ扱いにする
export type RecordingState = 'idle' | 'recording' | 'paused';
