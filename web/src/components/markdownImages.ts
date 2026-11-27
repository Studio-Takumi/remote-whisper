// 要約などの Markdown の画像を読み込まない（#252。spec/ui.md 8）。
// 外部の画像は「画像: <URL>」のリンクにし、data: などのそれ以外は出さない。raw HTML の <img> もここを通る
import { type StreamdownProps, defaultRehypePlugins } from 'streamdown';

type PluggableList = NonNullable<StreamdownProps['rehypePlugins']>;
type Pluggable = PluggableList[number];
// oxlint-disable-next-line typescript/no-explicit-any -- unified の Plugin の形に合わせる
type Plugin = Extract<Pluggable, (...args: any[]) => unknown>;

// hast の木（使う分だけ）
type HastNode = {
    type: string;
    tagName?: string;
    properties?: Record<string, unknown>;
    children?: HastNode[];
    value?: string;
};

// 外部の画像の URL。/i は念のためで、実際には効いていない（HTTPS: のような大文字のスキームは、
// この前の sanitize が src ごと落とすので、リンクにならずに消える。読み込まないのは同じ）
const EXTERNAL = /^(?:https?:)?\/\//i;

function imageLink(src: string, insideLink: boolean, label: ImageLabel): HastNode {
    const href = src.startsWith('//') ? `https:${src}` : src;
    const text: HastNode = { type: 'text', value: label(href) };
    // リンクの中の画像（[![](画像)](リンク)）は、リンクを入れ子にしない
    if (insideLink) {
        return { type: 'element', tagName: 'span', properties: {}, children: [text] };
    }
    return { type: 'element', tagName: 'a', properties: { href }, children: [text] };
}

function replaceImages(node: HastNode, insideLink: boolean, label: ImageLabel) {
    if (!node.children) return;
    const children: HastNode[] = [];
    for (const child of node.children) {
        // <picture> の <source srcset> は、Streamdown の sanitize が通す。中の <img> を消せば読み込まれないが、念のため消す
        if (child.type === 'element' && child.tagName === 'source') {
            continue;
        }
        if (child.type === 'element' && child.tagName === 'img') {
            const src = typeof child.properties?.src === 'string' ? child.properties.src.trim() : '';
            if (EXTERNAL.test(src)) {
                children.push(imageLink(src, insideLink, label));
            }
            continue;
        }
        replaceImages(child, insideLink || (child.type === 'element' && child.tagName === 'a'), label);
        children.push(child);
    }
    node.children = children;
}

// 画像のリンクの文字（「画像: <URL>」）を作る関数
type ImageLabel = (href: string) => string;

export function rehypeImagesToLinks(options: { label: ImageLabel }) {
    return (tree: HastNode) => replaceImages(tree, false, options.label);
}

// Streamdown の既定（raw → sanitize → harden）の、sanitize と harden の間に上を挟む。
// harden は画像を 1 つも許さない形にして、上で取りこぼしたものも読み込まない（念のため）
const [harden, hardenOptions] = defaultRehypePlugins.harden as [Plugin, Record<string, unknown>];

// 画像のリンクの文字は表示言語で変わるので、関数にしている（Markdown が表示言語ごとに作り直す）
export function createRehypePlugins(label: ImageLabel): PluggableList {
    return [
        defaultRehypePlugins.raw,
        defaultRehypePlugins.sanitize,
        [rehypeImagesToLinks as Plugin, { label }],
        [harden, { ...hardenOptions, allowedImagePrefixes: [], allowDataImages: false, imageBlockPolicy: 'remove' }],
    ];
}
