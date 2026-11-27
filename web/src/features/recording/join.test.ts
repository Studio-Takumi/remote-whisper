import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connection } from '@/api/connection';
import type { ClientMessage, ServerMessage } from '@/api/protocol';
import { Microphone } from '@/features/recording/audio/microphone';
import {
    SourceJoin,
    deviceName,
    forgetJoin,
    joinUnavailable,
    recalledJoin,
    rememberJoin,
} from '@/features/recording/join';

// 偽のマイクと接続で SourceJoin を動かす
function harness() {
    let onPcm: (pcm: Int16Array, level: number) => void = () => {};
    let listener: (m: ServerMessage) => void = () => {};
    const sent: ClientMessage[] = [];
    const frames: number[] = [];
    vi.spyOn(Microphone, 'open').mockImplementation(async (handler) => {
        onPcm = handler;
        return { close: () => {} } as unknown as Microphone;
    });
    vi.spyOn(connection, 'subscribe').mockImplementation((l) => {
        listener = l;
        return () => {};
    });
    vi.spyOn(connection, 'onStateChange').mockImplementation(() => () => {});
    vi.spyOn(connection, 'send').mockImplementation((m) => {
        sent.push(m);
    });
    vi.spyOn(connection, 'sendBinary').mockImplementation((data) => {
        frames.push(new DataView(data).getUint32(0, true));
    });
    const ended: (string | null)[] = [];
    const states: (string | null)[] = [];
    const join = new SourceJoin(
        's1',
        (j) => states.push(j?.state ?? null),
        (message) => ended.push(message),
    );
    return {
        join,
        sent,
        frames,
        ended,
        states,
        receive: (m: Record<string, unknown>) => listener(m as unknown as ServerMessage),
        speak: (seconds: number) => onPcm(new Int16Array(16000 * seconds), 0),
    };
}

const processing = { noiseSuppression: true, autoGainControl: true, echoCancellation: true };

describe('SourceJoin（#356）', () => {
    beforeEach(() => sessionStorage.clear());
    afterEach(() => vi.restoreAllMocks());

    it('読み込み直したら、覚えていた続きの連番から送り、lost を付けてつなぎ直す', async () => {
        rememberJoin('s1', 2, 10);
        const h = harness();
        await h.join.start(processing, recalledJoin('s1'));
        expect(h.sent).toEqual([{ type: 'join', session: 's1', source: 2, nextSeq: 10, lost: true }]);
        // 返事を待つ間にマイクの音が溜まる
        h.speak(1);
        expect(h.frames).toEqual([]);
        h.receive({ type: 'joined', session: 's1', source: 2, offsetSec: 0, rejoined: true });
        h.receive({ type: 'ack', session: 's1', seq: 9 });
        // 0 からではなく 10 から。ack(9) で消されない
        expect(h.frames).toEqual([10, 11]);
        h.receive({ type: 'ack', session: 's1', seq: 11 });
        expect(recalledJoin('s1')).toEqual({ source: 2, nextSeq: 12 });
    });

    it('つなぎ直しで cannot_join が返ったら、参加を終えて知らせる', async () => {
        rememberJoin('s1', 2, 3);
        const h = harness();
        await h.join.start(processing, recalledJoin('s1'));
        h.receive({ type: 'error', code: 'cannot_join', message: '録音中ではありません' });
        expect(h.ended).toEqual(['参加が切れました。もう一度参加してください']);
        expect(h.states.at(-1)).toBeNull();
        expect(recalledJoin('s1')).toBeNull();
    });

    it('参加したあとの関係ないエラーでは参加を終えない。返事待ちの bad_message は古いホスト', async () => {
        const h = harness();
        await h.join.start(processing, null);
        h.receive({ type: 'joined', session: 's1', source: 2, offsetSec: 0 });
        h.receive({ type: 'error', code: 'bad_message', message: 'x' });
        h.receive({ type: 'error', code: 'write_failed', message: 'x' });
        expect(h.ended).toEqual([]);

        const old = harness();
        await old.join.start(processing, null);
        old.receive({ type: 'error', code: 'bad_message', message: 'x' });
        expect(old.ended).toEqual(['このホストは参加に対応していません']);
    });
});

describe('録音中の参加（#356）', () => {
    afterEach(() => sessionStorage.clear());

    it('古いサーバー（join が来ない）では押せない', () => {
        expect(joinUnavailable(undefined)).toBe('このホストは参加に対応していません');
        expect(joinUnavailable({ available: true })).toBeNull();
        expect(joinUnavailable({ available: false, reason: 'limit' })).toBe('参加できる音源の数に達しています');
        expect(joinUnavailable({ available: false, reason: 'disabled' })).toBe('このホストでは参加できない設定です');
    });

    it('参加している音源をセッションごとに覚え、読み込み直したら同じ音源としてつなぎ直す', () => {
        expect(recalledJoin('s1')).toBeNull();
        rememberJoin('s1', 2, 15);
        expect(recalledJoin('s1')).toEqual({ source: 2, nextSeq: 15 });
        expect(recalledJoin('s2')).toBeNull();
        forgetJoin('s1');
        expect(recalledJoin('s1')).toBeNull();
        sessionStorage.setItem('rw-join:s3', '{broken');
        expect(recalledJoin('s3')).toBeNull();
    });

    it('端末の大まかな名前', () => {
        expect(deviceName('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('iPhone');
        expect(deviceName('Mozilla/5.0 (Linux; Android 15)')).toBe('Android');
        expect(deviceName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
        expect(deviceName('curl')).toBe('ブラウザ');
    });
});
