import { useLayoutEffect, useRef, useState } from 'react';

import { isScrolledToBottom, scrollToBottom } from '@/lib/scroll';

type Tab = 'transcript' | 'summary';

type TabScroll = { top: number; atBottom: boolean };

// タブごとのスクロール位置（window）を覚えて、切り替えたら戻す（#78。spec/ui.md 8）。
// 一番下にいたタブは伸びていても一番下に戻す。セッションを替えたら捨てる
export function useTabScroll(sessionId: string | undefined) {
    const [state, setState] = useState<{
        tab: Tab;
        sessionId: string | undefined;
        saved: Partial<Record<Tab, TabScroll>>;
    }>({ tab: 'transcript', sessionId, saved: {} });
    const restore = useRef<TabScroll | null>(null);

    const changeTab = (value: string) => {
        const next = value as Tab;
        const saved = {
            ...(state.sessionId === sessionId ? state.saved : {}),
            [state.tab]: { top: window.scrollY, atBottom: isScrolledToBottom() },
        };
        restore.current = saved[next] ?? { top: 0, atBottom: false };
        setState({ tab: next, sessionId, saved });
    };

    // 描き替えた後、画面に出る前に戻す
    useLayoutEffect(() => {
        if (restore.current !== null) {
            if (restore.current.atBottom) {
                scrollToBottom();
            } else {
                window.scrollTo({ top: restore.current.top });
            }
            restore.current = null;
        }
    }, [state.tab]);

    const transcript = state.sessionId === sessionId ? state.saved.transcript : undefined;
    // 文字起こしを出し直したとき、下を追うかどうか。初めて出すときは追う
    const followTranscript = transcript?.atBottom ?? true;
    return { tab: state.tab, changeTab, followTranscript };
}
