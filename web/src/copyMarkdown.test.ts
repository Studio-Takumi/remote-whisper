import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { Markdown } from '@/components/Markdown';
import { copySelection, htmlToMarkdown } from '@/copyMarkdown';

// 画面と同じ Markdown コンポーネント（Streamdown）で描画した HTML を使う
function render(md: string) {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(createElement(Markdown, { children: md }));
    document.body.replaceChildren(container);
    return container;
}

const summary = [
    '## 全体概要',
    '',
    '- 一つ目の **大事な** 点',
    '  - 入れ子の点',
    '- 二つ目の点',
    '',
    '1. 手順 1',
    '2. 手順 2',
    '',
    '| 用語 | 意味 |',
    '| --- | --- |',
    '| 浄書 | 文字起こしの清書 |',
    '',
    'エネルギーは $E=mc^2$ で表せる。',
    '',
    '$$',
    '\\int_0^1 x\\,dx = \\frac{1}{2}',
    '$$',
    '',
    '```python',
    'def f(x):',
    '    return x * 2',
    '```',
].join('\n');

describe('htmlToMarkdown', () => {
    const md = htmlToMarkdown(render(summary));

    it('見出し・太字・入れ子の箇条書き・番号付きリストを戻す', () => {
        expect(md).toContain('## 全体概要');
        expect(md).toMatch(/^- 一つ目の \*\*大事な\*\* 点\n {2}- 入れ子の点\n- 二つ目の点$/m);
        expect(md).toMatch(/^1\. 手順 1\n2\. 手順 2$/m);
    });

    it('表を戻し、表のボタンは入れない', () => {
        expect(md).toMatch(/\| 用語 \| 意味 \|\n\| -+ \| -+ \|\n\| 浄書 \| 文字起こしの清書 \|/);
        expect(md).not.toMatch(/Copy|Download|fullscreen/);
    });

    it('数式は元の TeX に戻す', () => {
        expect(md).toContain('エネルギーは $E=mc^2$ で表せる。');
        expect(md).toContain('$$\n\\int_0^1 x\\,dx = \\frac{1}{2}\n$$');
    });

    it('コードブロックは行を改行でつなぎ、言語名を付ける', () => {
        expect(md).toContain('```python\ndef f(x):\n    return x * 2\n```');
    });
});

describe('copySelection', () => {
    it('数式の途中から選んでも、数式ごと TeX で戻す', () => {
        const container = render('前の文 $E=mc^2$ 後の文');
        const range = document.createRange();
        // 数式の描画の中の文字（mathml の E）から、段落の最後まで
        const inner = container.querySelector('.katex-mathml mi')!.firstChild!;
        const paragraph = container.querySelector('p')!;
        range.setStart(inner, 0);
        range.setEnd(paragraph.lastChild!, paragraph.lastChild!.textContent!.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(copySelection(selection, container)?.markdown).toBe('$E=mc^2$ 後の文');
    });

    it('範囲がはみ出していれば、普通のコピーに任せる', () => {
        const container = render('本文');
        const outside = document.createElement('p');
        outside.textContent = '外';
        document.body.appendChild(outside);
        const range = document.createRange();
        range.setStart(container.querySelector('p')!.firstChild!, 0);
        range.setEnd(outside.firstChild!, 1);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        expect(copySelection(selection, container)).toBeNull();
    });
});
