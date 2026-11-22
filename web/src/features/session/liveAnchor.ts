// リアルタイム要約の「読んでいる位置」の目印選び（LiveSummary が使う）
// 上に貼り付けたバー（上のバー。タブ・再生バーも中にある。#463）の高さ。これより下が読める範囲。
// TopBar が --top-bar-height に出している（アプリのセーフエリアの分も入る）。出ていないとき（テストなど）の目安は 120
export function stickyTop() {
    const height = parseFloat(document.documentElement.style.getPropertyValue('--top-bar-height'));
    return Number.isFinite(height) ? height : 120;
}

// 目印にする区間。読める範囲の上から 1/3 のあたり（読んでいるところ）にかかっている区間。
// その区間が同じ位置にあれば、上の概要が伸び縮みしても、読んでいる文が動かない
export function findAnchor(root: HTMLElement | null) {
    if (!root) {
        return null;
    }
    // 一番上にいるとき（概要を見ているとき）は、ずらさない
    if (window.scrollY <= 0) {
        return null;
    }
    const top = stickyTop();
    const reading = top + (window.innerHeight - top) / 3;
    let last: { key: string; top: number } | null = null;
    for (const el of root.querySelectorAll<HTMLElement>('[data-live-section]')) {
        const rect = el.getBoundingClientRect();
        if (rect.top > reading) {
            break;
        }
        last = { key: el.dataset.liveSection ?? '', top: rect.top };
    }
    return last;
}
