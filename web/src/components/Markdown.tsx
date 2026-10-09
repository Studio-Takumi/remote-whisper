import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';
import { Streamdown } from 'streamdown';

// 講義の要約では $x$ のようなインライン数式が出てくるので、$ 1つでも数式として扱う
const math = createMathPlugin({ singleDollarTextMath: true });

// 要約の表示。要約は summary.delta で少しずつ届くので、書きかけの Markdown でも崩れにくい Streamdown を使う
export function Markdown({ children, streaming = false }: { children: string; streaming?: boolean }) {
    return (
        <Streamdown plugins={{ math, cjk }} isAnimating={streaming}>
            {children}
        </Streamdown>
    );
}
