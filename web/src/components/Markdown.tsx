import type { ClipboardEvent } from 'react';

import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { Streamdown } from 'streamdown';

import { copySelection } from '@/copyMarkdown';

// 講義の要約では $x$ のようなインライン数式が出てくるので、$ 1つでも数式として扱う
const math = createMathPlugin({ singleDollarTextMath: true });

// 選んでコピーしたときは、テキストとしては Markdown を渡す。HTML は今どおり渡し、HTML で貼るアプリでは見た目を保つ（#203）
function onCopy(e: ClipboardEvent<HTMLDivElement>) {
    const copied = copySelection(window.getSelection(), e.currentTarget);
    if (!copied) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', copied.markdown);
    e.clipboardData.setData('text/html', copied.html);
}

// 要約の表示。要約は summary.delta で少しずつ届くので、書きかけの Markdown でも崩れにくい Streamdown を使う
export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
    return (
        <div onCopy={onCopy}>
            <Streamdown plugins={{ code, math, cjk }} isAnimating={streaming}>
                {children}
            </Streamdown>
        </div>
    );
}
