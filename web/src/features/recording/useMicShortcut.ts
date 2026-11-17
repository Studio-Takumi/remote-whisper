import { useEffect, useRef } from 'react';

import { shouldHandleMicShortcut } from '@/features/settings/shortcut';

// マイクボタンのキーボードのショートカット（#236）。押すとマイクボタンを押したのと同じ動きにする。
// 文字を入力している途中・モーダルを開いているときは効かない（shortcut.ts）
export function useMicShortcut(combo: string, onPress: () => void) {
    const press = useRef(onPress);
    useEffect(() => {
        press.current = onPress;
    });
    useEffect(() => {
        if (combo === '') {
            return;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleMicShortcut(e, combo)) {
                return;
            }
            e.preventDefault();
            press.current();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [combo]);
}
