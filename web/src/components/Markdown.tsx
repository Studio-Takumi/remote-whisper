import { type ClipboardEvent, useMemo } from 'react';

import { cjk } from '@streamdown/cjk';
import { code } from '@streamdown/code';
import { createMathPlugin } from '@streamdown/math';
import { Streamdown } from 'streamdown';

import { copySelection } from '@/components/copyMarkdown';
import { componentsMessages } from '@/components/i18n';
import { createRehypePlugins } from '@/components/markdownImages';
import { contentLang } from '@/i18n/contentLang';
import { useT } from '@/i18n/messages';

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
    const t = useT(componentsMessages);
    // 画像のリンクの文字（「画像: <URL>」）は表示言語で変わるので、言語ごとに作る
    const rehypePlugins = useMemo(() => createRehypePlugins((href) => t('markdownImages.image', { href })), [t]);
    return (
        // 中身（要約）の言語で lang を付ける（#497。英語の表示でも日本語の字形で出す）
        <div onCopy={onCopy} lang={contentLang(children)}>
            <Streamdown plugins={{ code, math, cjk }} rehypePlugins={rehypePlugins} isAnimating={streaming}>
                {children}
            </Streamdown>
        </div>
    );
}
