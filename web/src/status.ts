import type { RecordingState } from '@/recording';

// サーバーとブラウザの状態。後で WebSocket の status メッセージ（spec 7.2 節）とマイクの許可から作る
export type ServerStatus = {
    whisper: 'unloaded' | 'loading' | 'ready' | 'error';
    ollama: 'ready' | 'error';
    connection: 'connected' | 'reconnecting';
    microphone: 'granted' | 'denied';
};

export const initialServerStatus: ServerStatus = {
    whisper: 'unloaded',
    ollama: 'ready',
    connection: 'connected',
    microphone: 'granted',
};

// StatusIndicator に出す内容
export type Tone = 'idle' | 'active' | 'paused' | 'warning' | 'error';
export type Status = { tone: Tone; text: string };

// 文字起こしタブ用
export function transcriptStatus(state: RecordingState, server: ServerStatus): Status {
    if (state === 'idle') {
        return { tone: 'idle', text: '待機中' };
    }
    if (server.connection === 'reconnecting') {
        return { tone: 'warning', text: 'サーバーに再接続しています…（録音は続けています）' };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: '一時停止中' };
    }
    if (server.whisper === 'error') {
        return { tone: 'error', text: '文字起こしが止まっています。音声は保存しているので、後から作り直せます' };
    }
    if (server.whisper !== 'ready') {
        return { tone: 'warning', text: '文字起こしのモデルを読み込んでいます…（音声は保存しています）' };
    }
    return { tone: 'active', text: '文字起こし中…' };
}

// 要約タブ用。録音していないときは出さない
export function summaryStatus(state: RecordingState, server: ServerStatus, intervalMin: number): Status | null {
    if (state === 'idle') {
        return null;
    }
    if (server.connection === 'reconnecting') {
        return { tone: 'warning', text: 'サーバーに再接続しています…（録音は続けています）' };
    }
    if (server.ollama === 'error') {
        return { tone: 'error', text: 'Ollama に接続できないため、要約を作れません。録音が終わった後に作り直せます' };
    }
    if (state === 'paused') {
        return { tone: 'paused', text: '一時停止中。再開すると要約の更新も再開します' };
    }
    return { tone: 'active', text: `録音中。${intervalMin} 分おきに途中の要約を更新します…` };
}
