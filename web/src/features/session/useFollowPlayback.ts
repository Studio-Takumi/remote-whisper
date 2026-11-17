import { useCallback, useEffect, useRef, useState } from 'react';

// 再生位置の行が見えるように追う（#122）。自分でスクロールしたら追うのをやめ、「再生位置に戻る」で戻す。
// シークしたら（時刻を押した・再生バーで動かした）、また追う
export function useFollowPlayback(active: number | null, seeks: number, playing: boolean) {
    const activeRow = useRef<HTMLDivElement>(null);
    const [stopped, setStopped] = useState({ seeks, stopped: false });
    // シークしたら追い直す（シークの回数が変わったら、やめていたことを忘れる）
    const following = stopped.seeks !== seeks || !stopped.stopped;

    // 再生中に、ホイール・タッチ・キーでスクロールしたら追うのをやめる
    // （scroll イベントは自分で動かしたときにも来るので、人の操作だけを見る）
    useEffect(() => {
        if (!playing) {
            return;
        }
        const stop = (e: Event) => {
            if (scrollsPage(e.target)) {
                setStopped({ seeks, stopped: true });
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (
                ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) &&
                !isEditable(e.target)
            ) {
                stop(e);
            }
        };
        window.addEventListener('wheel', stop, { passive: true });
        window.addEventListener('touchmove', stop, { passive: true });
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('wheel', stop);
            window.removeEventListener('touchmove', stop);
            window.removeEventListener('keydown', onKey);
        };
    }, [playing, seeks]);

    useEffect(() => {
        if (active !== null && following) {
            activeRow.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [active, following]);

    const followAgain = useCallback(() => setStopped({ seeks, stopped: false }), [seeks]);
    return { activeRow, following, followAgain };
}

// ページのスクロールになる操作か。ダイアログ・選択肢の一覧・再生バーの中の操作は、ページを動かさない
function scrollsPage(target: EventTarget | null) {
    return !(target instanceof Element && target.closest('[role="dialog"], [role="listbox"], [role="menu"], audio'));
}

// 文字を入力している・値を選んでいるところ（矢印キーなどはその中で使う）
function isEditable(target: EventTarget | null) {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
}
