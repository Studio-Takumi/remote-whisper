import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MicState } from '@/features/recording/audio/microphone';
import { MicRecovery, RETRY_DELAYS } from '@/features/recording/micRecovery';

// 割り込みのあと、自動で録音に戻す（#447）
let state: MicState;
let active: boolean;
let visibility: DocumentVisibilityState;
let target: {
    active: () => boolean;
    state: () => MicState;
    resume: Mock<() => Promise<void>>;
    reopen: Mock<() => Promise<void>>;
    recovered: Mock<() => void>;
};
let recovery: MicRecovery;

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    state = 'ok';
    active = true;
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    target = {
        active: () => active,
        state: () => state,
        resume: vi.fn(async () => {}),
        reopen: vi.fn(async () => {
            state = 'ok';
        }),
        recovered: vi.fn(),
    };
    recovery = new MicRecovery(target);
    recovery.start();
});

afterEach(() => {
    recovery.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function stopMic(next: MicState) {
    state = next;
    recovery.changed(next);
}

describe('MicRecovery', () => {
    it('止まってから少し待って、マイクを開き直す', async () => {
        stopMic('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] - 1);
        expect(target.reopen).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(target.reopen).toHaveBeenCalledTimes(1);
        expect(target.recovered).toHaveBeenCalledTimes(1);
    });

    it('音声の処理が止まっただけなら、動かし直して戻す（開き直さない）', async () => {
        target.resume.mockImplementation(async () => {
            state = 'ok';
        });
        stopMic('suspended');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0]);
        expect(target.resume).toHaveBeenCalledTimes(1);
        expect(target.reopen).not.toHaveBeenCalled();
        expect(target.recovered).toHaveBeenCalledTimes(1);
    });

    it('動かし直しが返ってこなくても、待たずに開き直す', async () => {
        target.resume.mockImplementation(() => new Promise(() => {}));
        stopMic('suspended');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] + 1000);
        expect(target.reopen).toHaveBeenCalledTimes(1);
    });

    it('自然に戻ったら試さない', async () => {
        stopMic('muted');
        stopMic('ok');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(target.reopen).not.toHaveBeenCalled();
        expect(target.recovered).not.toHaveBeenCalled();
    });

    it('戻らなければ間を空けて試し、決まった回数でやめる', async () => {
        target.reopen.mockImplementation(async () => {});
        stopMic('muted');
        const total = RETRY_DELAYS.reduce((a, b) => a + b, 0);
        await vi.advanceTimersByTimeAsync(total * 2);
        expect(target.reopen).toHaveBeenCalledTimes(RETRY_DELAYS.length);
        expect(target.recovered).not.toHaveBeenCalled();
    });

    it('開き直しに失敗しても、次を試す', async () => {
        target.reopen.mockRejectedValueOnce(new Error('NotReadableError'));
        stopMic('ended');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS[0] + RETRY_DELAYS[1]);
        expect(target.reopen).toHaveBeenCalledTimes(2);
        expect(target.recovered).toHaveBeenCalledTimes(1);
    });

    it('一時停止の間は戻さない', async () => {
        active = false;
        stopMic('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(target.reopen).not.toHaveBeenCalled();
    });

    it('裏にいる間は開き直さず、前面に戻ったらすぐ試す', async () => {
        visibility = 'hidden';
        stopMic('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        expect(target.reopen).not.toHaveBeenCalled();
        visibility = 'visible';
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(0);
        expect(target.reopen).toHaveBeenCalledTimes(1);
        expect(target.recovered).toHaveBeenCalledTimes(1);
    });

    it('あきらめたあとも、前面に戻ったら試し直す', async () => {
        target.reopen.mockImplementation(async () => {});
        stopMic('muted');
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.reduce((a, b) => a + b, 0) * 2);
        expect(target.reopen).toHaveBeenCalledTimes(RETRY_DELAYS.length);
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
        expect(target.reopen).toHaveBeenCalledTimes(RETRY_DELAYS.length + 1);
    });

    it('止めたら試さない', async () => {
        stopMic('muted');
        recovery.stop();
        await vi.advanceTimersByTimeAsync(RETRY_DELAYS.at(-1)! * 2);
        window.dispatchEvent(new Event('focus'));
        await vi.advanceTimersByTimeAsync(0);
        expect(target.reopen).not.toHaveBeenCalled();
    });
});
