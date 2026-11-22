// 再生バーが消えたことを呼ぶ側に伝える（画面の回転で audio が作り直されても、再生の状態が古いまま残らないように。#463）
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RecordingPlayer } from '@/features/session/RecordingPlayer';

afterEach(cleanup);

describe('RecordingPlayer の unmount', () => {
    it('消えたら onUnmount を 1 回呼ぶ（描き直しでは呼ばない）', () => {
        const onUnmount = vi.fn();
        const props = { src: '/rec', audio: { current: null }, onError: () => {}, onUnmount };
        const { rerender, unmount } = render(<RecordingPlayer {...props} />);
        rerender(<RecordingPlayer {...props} src='/rec2' />);
        expect(onUnmount).not.toHaveBeenCalled();
        unmount();
        expect(onUnmount).toHaveBeenCalledTimes(1);
    });
});
