// ページ全体のスクロールの位置。文字起こしの「下を追う」とタブの位置の記憶で使う

// 一番下から、これだけ以内なら一番下にいるとみなす（マイクのボタンの分を含む）
const BOTTOM_MARGIN = 160;

export function isScrolledToBottom() {
    const el = document.scrollingElement ?? document.documentElement;
    return el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_MARGIN;
}

export function scrollToBottom() {
    const el = document.scrollingElement ?? document.documentElement;
    window.scrollTo({ top: el.scrollHeight });
}
