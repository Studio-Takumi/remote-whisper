import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerMessage } from '@/api/protocol';
import type { Project, Session } from '@/api/types';
import type { useAppStore as Store } from '@/app/store';
import { type FakeConnection, fakeConnection } from '@/test/fakeConnection';
import { type FakeMicrophone, fakeMicrophone } from '@/test/fakeMicrophone';
import { seedProjects, sessionReader } from '@/test/seedProjects';

// store の録音の流れ（#378）。store を分ける（#331）前に、今の動きを固定する。
// store は録音の状態をモジュールの変数に持つので、テストごとに読み込み直す
const SESSION = '2026-11-17_10-00-00';

let store: typeof Store;
let ws: FakeConnection;
let mic: FakeMicrophone;

async function setup(projects: Project[], selection: { projectId: string; sessionId: string | null }) {
    vi.resetModules();
    const { connection } = await import('@/api/connection');
    const { Microphone } = await import('@/features/recording/audio/microphone');
    ws = fakeConnection(connection);
    mic = fakeMicrophone(Microphone);
    ({ useAppStore: store } = await import('@/app/store'));
    // 一覧と中身はキャッシュに入れる（#361）
    await seedProjects(store, projects);
    readSession = await sessionReader(store);
    store.setState({ selection, projectsLoaded: true });
    store.getState().connectServer();
}

function receive(message: ServerMessage) {
    ws.receive(message);
}

let readSession: (id: string) => Session | undefined;

function session(id = SESSION) {
    return readSession(id);
}

// 新しいセッションの画面から録音を始め、サーバーが started を返す
async function startRecording() {
    await setup([{ id: 'p1', name: 'p1', path: '/p1', sessions: [] }], { projectId: 'p1', sessionId: null });
    const starting = store.getState().startRecording();
    await vi.waitFor(() => expect(ws.log()).toContain('start'));
    receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
    await starting;
}

// 切れたあと、つながり直して resume が通り、サーバーが受け取り済みの最後の連番を ack で返す
async function reconnectAndResume(ackedSeq: number) {
    ws.reconnect();
    await vi.waitFor(() => expect(ws.log()).toContain('resume'));
    receive({ type: 'started', session: SESSION, resumed: true });
    // started の処理（await の続き）が済むまで ack を送る。同じ連番の ack は何度受けても同じ
    await vi.waitFor(() => {
        receive({ type: 'ack', session: SESSION, seq: ackedSeq });
        expect(ws.log().at(-1)).not.toBe('resume');
    });
}

beforeEach(() => {
    // 一覧・参考資料・バージョンの取り直しは、ここでは失敗させる（取れなければ前のまま）
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('録音（自分の端末）', () => {
    it('開始 → partial・final → 一時停止 → 再開 → 停止', async () => {
        await startRecording();
        expect(ws.wire[0]).toEqual({ type: 'start', project: 'p1' });
        const s = store.getState();
        expect(s.recordingState).toBe('recording');
        expect(s.recordingSessionId).toBe(SESSION);
        expect(s.selection).toEqual({ projectId: 'p1', sessionId: SESSION });
        expect(session()).toMatchObject({ uuid: 'uuid-1', status: 'recording', transcript: [] });

        // 0.5 秒ごとに 1 チャンクにして、連番を付けて送る。ack まで手元に残す
        mic.speak(16000);
        expect(ws.log()).toEqual(['start', 'audio:0', 'audio:1']);
        expect(store.getState().elapsed).toBe(1);
        expect(store.getState().pendingAudio).toBe(2);
        receive({ type: 'ack', session: SESSION, seq: 1 });
        expect(store.getState().pendingAudio).toBe(0);

        // partial は区間ごとに出し、final で行にして partial を消す
        receive({ type: 'partial', session: SESSION, segment: 0, committed: 'こんに', tentative: 'ちは' });
        expect(store.getState().partials).toHaveLength(1);
        receive({ type: 'final', session: SESSION, segment: 0, start: 0, end: 1, text: 'こんにちは' });
        expect(store.getState().partials).toHaveLength(0);
        expect(session()?.transcript.map((l) => l.text)).toEqual(['こんにちは']);
        // text が空の final は行にしない
        receive({ type: 'partial', session: SESSION, segment: 1, committed: '', tentative: 'えー' });
        receive({ type: 'final', session: SESSION, segment: 1, start: 1, end: 2, text: '' });
        expect(store.getState().partials).toHaveLength(0);
        expect(session()?.transcript).toHaveLength(1);

        // 一時停止の前までの半端な音声を送り切ってから pause を送る
        mic.speak(4000);
        await store.getState().pauseRecording();
        expect(ws.log().slice(-2)).toEqual(['audio:2', 'pause']);
        expect(store.getState().recordingState).toBe('paused');

        // 一時停止中の音声は送らず、経過時間も進めない
        mic.speak(16000);
        expect(ws.log().at(-1)).toBe('pause');
        expect(store.getState().elapsed).toBe(1);

        store.getState().resumeRecording();
        expect(ws.log().at(-1)).toBe('unpause');
        expect(store.getState().recordingState).toBe('recording');
        mic.speak(8000);
        expect(ws.log().at(-1)).toBe('audio:3');

        // 停止の前までの音声を送り切ってから stop を送る。セッションは終わり、最終の要約を待つ
        mic.speak(2000);
        await store.getState().stopRecording();
        expect(ws.log().slice(-2)).toEqual(['audio:4', 'stop']);
        const done = store.getState();
        expect(done.recordingState).toBe('idle');
        expect(done.recordingSessionId).toBeNull();
        // 経過時間は送ったサンプルの数から出す（16000 + 4000 + 8000 + 2000 = 1.875 秒）
        expect(done.elapsed).toBe(1);
        expect(session()).toMatchObject({ status: 'done', durationSec: 1 });
        expect(session()?.endedAt).toBeTruthy();
        expect(done.generating?.sessionId).toBe(SESSION);
        expect(mic.closed).toBe(1);
    });

    it('録音中の terms・途中の要約を出し、録音を終えたあとの途中の要約は出さない', async () => {
        await startRecording();
        receive({ type: 'terms', session: SESSION, terms: ['Whisper'], rejected: [] });
        expect(session()).toMatchObject({ pickedTerms: ['Whisper'] });

        receive({ type: 'summary.delta', session: SESSION, kind: 'live', text: '断片' });
        expect(store.getState().liveDraft).toBeNull();
        receive({ type: 'summary.delta', session: SESSION, kind: 'live', text: 'まとめ', replace: true });
        receive({ type: 'summary.delta', session: SESSION, kind: 'live', text: 'の続き' });
        expect(store.getState().liveDraft).toEqual({ sessionId: SESSION, text: 'まとめの続き' });
        receive({ type: 'summary.done', session: SESSION, kind: 'live' });
        expect(store.getState().liveDraft).toBeNull();
        expect(session()?.liveSummary).toBe('まとめの続き');

        await store.getState().stopRecording();
        receive({ type: 'summary.delta', session: SESSION, kind: 'live', text: '遅れた要約', replace: true });
        expect(store.getState().liveDraft).toBeNull();
    });

    it('録音を終えた後に届いた final も足す', async () => {
        await startRecording();
        await store.getState().stopRecording();
        receive({ type: 'final', session: SESSION, segment: 0, start: 0, end: 1, text: '最後の行' });
        expect(session()?.transcript.map((l) => l.text)).toEqual(['最後の行']);
    });

    it('録音中のセッションを見ていることになっていても、行・語は録音の購読で足す', async () => {
        await startRecording();
        store.setState({ watching: { sessionId: SESSION, state: 'recording' } });
        receive({ type: 'final', session: SESSION, segment: 0, start: 0, end: 1, text: '録音の行' });
        receive({ type: 'terms', session: SESSION, terms: ['Whisper'], rejected: [] });
        expect(session()?.transcript.map((l) => l.text)).toEqual(['録音の行']);
        expect(session()?.pickedTerms).toEqual(['Whisper']);
    });

    it('録音中に切れる → つながり直して resume → 届かなかった音声を送り直す', async () => {
        await startRecording();
        mic.speak(8000);
        receive({ type: 'ack', session: SESSION, seq: 0 });

        ws.disconnect();
        expect(store.getState().server.connection).toBe('reconnecting');
        // 切れている間も録音は続け、音声は送らずに溜める（経過時間は進む）
        mic.speak(16000);
        expect(ws.log()).toEqual(['start', 'audio:0']);
        expect(store.getState().recordingState).toBe('recording');
        expect(store.getState().elapsed).toBe(1);
        expect(store.getState().pendingAudio).toBe(2);

        // resume の nextSeq は ack されていない最初の連番
        await reconnectAndResume(0);
        expect(ws.wire.find((w) => w.type === 'resume')).toEqual({ type: 'resume', session: SESSION, nextSeq: 1 });
        // ack の次から順に送り直し、切れている間の一時停止・再開に備えて今の状態を送る
        expect(ws.log().slice(2)).toEqual(['resume', 'audio:1', 'audio:2', 'unpause']);
        expect(store.getState().server.connection).toBe('connected');

        // そのあとは普段どおり送る
        mic.speak(8000);
        expect(ws.log().at(-1)).toBe('audio:3');
        receive({ type: 'ack', session: SESSION, seq: 3 });
        expect(store.getState().pendingAudio).toBe(0);
    });

    it('切れている間に一時停止していたら、送り直したあとに pause を送る', async () => {
        await startRecording();
        mic.speak(8000);
        receive({ type: 'ack', session: SESSION, seq: 0 });
        ws.disconnect();
        mic.speak(8000);
        await store.getState().pauseRecording();
        expect(store.getState().recordingState).toBe('paused');

        await reconnectAndResume(0);
        expect(ws.log().slice(2)).toEqual(['resume', 'audio:1', 'pause']);
    });

    it('切れている間に停止 → つながり直して残りと stop を送る', async () => {
        await startRecording();
        mic.speak(8000);
        receive({ type: 'ack', session: SESSION, seq: 0 });
        ws.disconnect();
        mic.speak(10000);

        // 停止は画面ではすぐ終わるが、stop はまだ送れない（音声を溜めている）
        await store.getState().stopRecording();
        expect(ws.log()).toEqual(['start', 'audio:0']);
        expect(store.getState().recordingState).toBe('idle');
        expect(session()?.status).toBe('done');

        // 残りを送り終えるまでは、次の録音を始めない
        store.setState({ selection: { projectId: 'p1', sessionId: null } });
        await store.getState().startRecording();
        expect(ws.log().filter((t) => t === 'start')).toHaveLength(1);
        expect(mic.opened).toBe(1);

        // 半端な分も 1 チャンクにして溜めてあり、送り直してから stop を送る（unpause は送らない）
        await reconnectAndResume(0);
        expect(ws.wire.find((w) => w.type === 'resume')).toEqual({ type: 'resume', session: SESSION, nextSeq: 1 });
        expect(ws.log().slice(2)).toEqual(['resume', 'audio:1', 'audio:2', 'stop']);
        expect(ws.wire.at(-2)).toEqual({ type: 'audio', seq: 2, samples: 2000 });
    });

    it('resume に session_not_found が返ったら、録音は途中で終わったことにする', async () => {
        await startRecording();
        mic.speak(8000);
        ws.disconnect();
        ws.reconnect();
        await vi.waitFor(() => expect(ws.log()).toContain('resume'));
        receive({ type: 'error', session: SESSION, code: 'session_not_found', message: 'not found' });
        await vi.waitFor(() => expect(store.getState().recordingState).toBe('idle'));
        expect(store.getState().recordingSessionId).toBeNull();
        expect(session()?.status).toBe('interrupted');
        expect(mic.closed).toBe(1);
    });
});

describe('ほかの端末の録音を見る（watch）', () => {
    const WATCHED = '2026-11-17_09-00-00';

    async function startWatching() {
        const recording = {
            id: WATCHED,
            title: '新しいセッション',
            startedAt: '2026-11-17 09:00',
            status: 'recording' as const,
            transcript: [],
            summaries: [],
        };
        await setup([{ id: 'p1', name: 'p1', path: '/p1', sessions: [recording] }], {
            projectId: 'p1',
            sessionId: WATCHED,
        });
    }

    it('つながったら watch を送り、そこまでの中身と partial・final・terms・途中の要約を出す', async () => {
        await startWatching();
        expect(ws.wire).toEqual([{ type: 'watch', session: WATCHED }]);

        // watching で、そこまでの文字起こし・途中の要約・タイトルに置き換える
        receive({
            type: 'watching',
            session: WATCHED,
            state: 'recording',
            transcript: [{ time: '00:00:01', text: '前の行' }],
            liveSummary: '前の要約',
            title: '講義',
        });
        expect(store.getState().watching).toMatchObject({ sessionId: WATCHED, state: 'recording' });
        expect(session(WATCHED)).toMatchObject({
            transcript: [{ time: '00:00:01', text: '前の行' }],
            liveSummary: '前の要約',
            title: '講義',
            loaded: true,
        });

        receive({ type: 'partial', session: WATCHED, segment: 3, committed: '続', tentative: 'き' });
        expect(store.getState().partials).toHaveLength(1);
        receive({ type: 'final', session: WATCHED, segment: 3, start: 2, end: 3, text: '続き' });
        expect(store.getState().partials).toHaveLength(0);
        expect(session(WATCHED)?.transcript.map((l) => l.text)).toEqual(['前の行', '続き']);

        receive({ type: 'terms', session: WATCHED, terms: ['Whisper'], rejected: [], manual: ['Ollama'] });
        expect(session(WATCHED)).toMatchObject({ pickedTerms: ['Whisper'], manualTerms: ['Ollama'] });

        // 途中の要約は replace から積み、done でセッションに入れる
        receive({ type: 'summary.delta', session: WATCHED, kind: 'live', text: '断片' });
        expect(store.getState().liveDraft).toBeNull();
        receive({ type: 'summary.delta', session: WATCHED, kind: 'live', text: 'まとめ', replace: true });
        receive({ type: 'summary.delta', session: WATCHED, kind: 'live', text: 'の続き' });
        expect(store.getState().liveDraft).toEqual({ sessionId: WATCHED, text: 'まとめの続き' });
        receive({ type: 'summary.done', session: WATCHED, kind: 'live' });
        expect(store.getState().liveDraft).toBeNull();
        expect(session(WATCHED)?.liveSummary).toBe('まとめの続き');

        receive({ type: 'recordingState', session: WATCHED, state: 'paused' });
        expect(store.getState().watching?.state).toBe('paused');
    });

    it('見ていないセッションのメッセージは出さない', async () => {
        await startWatching();
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });
        receive({ type: 'final', session: 'other', segment: 0, start: 0, end: 1, text: 'ほか' });
        receive({ type: 'partial', session: 'other', segment: 0, committed: 'ほ', tentative: 'か' });
        expect(store.getState().partials).toHaveLength(0);
        expect(session(WATCHED)?.transcript).toEqual([]);
    });

    it('watching が idle なら見るのをやめ、そのあとの final は出さない', async () => {
        await startWatching();
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });
        receive({ type: 'watching', session: WATCHED, state: 'idle' });
        expect(store.getState().watching).toBeNull();
        receive({ type: 'final', session: WATCHED, segment: 0, start: 0, end: 1, text: '届かない' });
        expect(session(WATCHED)?.transcript).toEqual([]);
    });

    it('title が届いたら、仮のタイトルとして出す', async () => {
        await startWatching();
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });
        receive({ type: 'title', session: WATCHED, title: '線形代数の講義', provisional: true });
        expect(session(WATCHED)).toMatchObject({ title: '線形代数の講義', provisionalTitle: true });
    });

    it('録音しながら見ているとき、録音の途中の要約の done で、見ている側の下書きを使わない', async () => {
        await startWatching();
        store.setState({ selection: { projectId: 'p1', sessionId: null } });
        const starting = store.getState().startRecording();
        await vi.waitFor(() => expect(ws.log()).toContain('start'));
        receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
        await starting;
        store.setState({ selection: { projectId: 'p1', sessionId: WATCHED } });
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });

        receive({ type: 'summary.delta', session: WATCHED, kind: 'live', text: '見ている要約', replace: true });
        receive({ type: 'summary.done', session: SESSION, kind: 'live' });
        expect(session()?.liveSummary).toBeUndefined();
        expect(store.getState().liveDraft).toEqual({ sessionId: WATCHED, text: '見ている要約' });
    });

    it('録音しながら見ているとき、見ているセッションの final は 1 回だけ足す', async () => {
        await startWatching();
        store.setState({ selection: { projectId: 'p1', sessionId: null } });
        const starting = store.getState().startRecording();
        await vi.waitFor(() => expect(ws.log()).toContain('start'));
        receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
        await starting;
        store.setState({ selection: { projectId: 'p1', sessionId: WATCHED } });
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });

        receive({ type: 'final', session: WATCHED, segment: 0, start: 0, end: 1, text: '見ている行' });
        expect(session(WATCHED)?.transcript.map((l) => l.text)).toEqual(['見ている行']);
        receive({ type: 'final', session: SESSION, segment: 0, start: 0, end: 1, text: '録音の行' });
        expect(session()?.transcript.map((l) => l.text)).toEqual(['録音の行']);
    });

    it('録音を終えた後にほかの端末の録音を見るとき、見ているセッションの final は 1 回だけ足す', async () => {
        await startWatching();
        store.setState({ selection: { projectId: 'p1', sessionId: null } });
        const starting = store.getState().startRecording();
        await vi.waitFor(() => expect(ws.log()).toContain('start'));
        receive({ type: 'started', session: SESSION, sessionUuid: 'uuid-1' });
        await starting;
        await store.getState().stopRecording();
        // 録音の購読は次の録音まで残る
        store.setState({ selection: { projectId: 'p1', sessionId: WATCHED } });
        receive({ type: 'watching', session: WATCHED, state: 'recording', transcript: [] });

        receive({ type: 'final', session: WATCHED, segment: 0, start: 0, end: 1, text: '見ている行' });
        expect(session(WATCHED)?.transcript.map((l) => l.text)).toEqual(['見ている行']);
    });

    it('つながり直したら watch を送り直す', async () => {
        await startWatching();
        ws.disconnect();
        ws.reconnect();
        expect(ws.wire).toEqual([
            { type: 'watch', session: WATCHED },
            { type: 'watch', session: WATCHED },
        ]);
    });
});
