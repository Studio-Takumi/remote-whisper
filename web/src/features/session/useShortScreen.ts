import { useSyncExternalStore } from 'react';

// 横持ちのスマホなど、高さが足りない画面（#463）。上のバーにタブ・再生バーまで入れると本文が読めなくなるので、
// こういう画面では再生バーなどを上のバーに入れず、本文の頭に置く
const SHORT_SCREEN = '(max-height: 500px)';

// matchMedia のない環境（jsdom など）では、高さは足りているものとする
function query() {
    return typeof window.matchMedia === 'function' ? window.matchMedia(SHORT_SCREEN) : null;
}

function subscribe(onChange: () => void) {
    const mql = query();
    mql?.addEventListener('change', onChange);
    return () => mql?.removeEventListener('change', onChange);
}

export function useShortScreen() {
    return useSyncExternalStore(
        subscribe,
        () => query()?.matches ?? false,
        () => false,
    );
}
