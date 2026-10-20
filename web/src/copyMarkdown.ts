import TurndownService from 'turndown';
import { tables } from 'turndown-plugin-gfm';

// 要約を選んでコピーしたとき、Streamdown が描画した HTML を Markdown に戻す（#203）。
// Streamdown は太字を span、コードを行ごとの span、数式を KaTeX で描くので、その形に合わせて戻す

const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
});
turndown.use(tables);

// 表やコードブロックのボタン、コードブロックの言語名の見出しはコピーしない
turndown.remove(
    (node) =>
        ['BUTTON', 'svg'].includes(node.nodeName) ||
        ['code-block-header', 'code-block-actions'].includes(node.getAttribute('data-streamdown') ?? ''),
);

// turndown の既定は「-   項目」（記号のあとに空白 3 つ）なので、要約の書き方に合わせて空白 1 つにする。
// 入れ子は記号の幅だけ字下げする
turndown.addRule('listItem', {
    filter: 'li',
    replacement: (content, node) => {
        const parent = node.parentNode as HTMLElement | null;
        let prefix = '- ';
        if (parent?.nodeName === 'OL') {
            const start = Number(parent.getAttribute('start') ?? 1);
            prefix = `${start + Array.prototype.indexOf.call(parent.children, node)}. `;
        }
        const body = content
            .replace(/^\n+/, '')
            .replace(/\n+$/, '\n')
            .replace(/\n(?!$)/g, `\n${' '.repeat(prefix.length)}`);
        return prefix + body + (node.nextSibling && !body.endsWith('\n') ? '\n' : '');
    },
});

turndown.addRule('strong', {
    filter: (node) => node.getAttribute('data-streamdown') === 'strong',
    replacement: (content) => (content.trim() ? `**${content}**` : content),
});

// 数式は KaTeX が残している元の TeX を使う。ブロックの数式（katex-display）は $$ で囲む
turndown.addRule('math', {
    filter: (node) => node.classList.contains('katex-display') || node.classList.contains('katex'),
    replacement: (_content, node) => {
        const el = node as HTMLElement;
        const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent?.trim() ?? '';
        return el.classList.contains('katex-display') ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
    },
});

// コードは 1 行ずつ span になっていて改行の文字がないので、行の span を改行でつなぐ
turndown.addRule('codeBlock', {
    filter: (node) => node.getAttribute('data-streamdown') === 'code-block',
    replacement: (_content, node) => {
        const el = node as HTMLElement;
        const code = el.querySelector('code');
        const lines = code ? Array.from(code.children, (line) => line.textContent ?? '') : [];
        const text = lines.length > 0 ? lines.join('\n') : (code?.textContent ?? '');
        return `\n\n\`\`\`${el.getAttribute('data-language') ?? ''}\n${text}\n\`\`\`\n\n`;
    },
});

export function htmlToMarkdown(root: Node) {
    return turndown.turndown(root as HTMLElement);
}

// 選んだ範囲の端が数式やコードブロックの途中なら、その要素ごと選んだことにする（TeX の原文が欠けないように）
function widen(range: Range) {
    const whole = (node: Node) =>
        (node instanceof Element ? node : node.parentElement)?.closest(
            '.katex-display, .katex, [data-streamdown="code-block"]',
        );
    const start = whole(range.startContainer);
    if (start) range.setStartBefore(start);
    const end = whole(range.endContainer);
    if (end) range.setEndAfter(end);
}

// 文字列をクリップボードに入れる。navigator.clipboard は https か localhost でしか使えないので、
// LAN の http で開いているときは、見えない textarea を選んで execCommand('copy') する
export async function copyText(text: string) {
    if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return;
    }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
        if (!document.execCommand('copy')) throw new Error('コピーできませんでした');
    } finally {
        textarea.remove();
    }
}

// 選んだ範囲を Markdown（text/plain 用）と HTML（text/html 用）にする。
// 範囲が container の外にはみ出していれば null（ブラウザの普通のコピーに任せる）
export function copySelection(selection: Selection | null, container: HTMLElement) {
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const range = selection.getRangeAt(0).cloneRange();
    if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;
    widen(range);
    const wrapper = document.createElement('div');
    wrapper.appendChild(range.cloneContents());
    return { markdown: htmlToMarkdown(wrapper), html: wrapper.innerHTML };
}
