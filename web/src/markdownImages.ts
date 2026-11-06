// 要約などの Markdown の画像を読み込まない（#252）。
// Streamdown の既定は外部の画像をそのまま読み込むので、要約に ![](https://…) が出るとほかのサーバーに取りに行く
// （ダイレクト版の「外に何も送らない」に反する。録音の発言から LLM を誘導して、要約の中身を URL に入れさせることもできる）。
// 外部の画像は「画像: <URL>」のリンクにする（押したときだけ、Streamdown のリンクの確認を経て開く）。
// data: などのそれ以外の画像は出さない。raw HTML の <img> も、Streamdown の rehype-raw で要素になってから、ここを通る。
// ほかに外を読みに行く要素（video・iframe・style など）は、Streamdown の sanitize が通さない
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

const EXTERNAL = /^(?:https?:)?\/\//i;

function imageLink(src: string, insideLink: boolean): HastNode {
    const href = src.startsWith('//') ? `https:${src}` : src;
    const text: HastNode = { type: 'text', value: `画像: ${href}` };
    // リンクの中の画像（[![](画像)](リンク)）は、リンクを入れ子にしない
    if (insideLink) {
        return { type: 'element', tagName: 'span', properties: {}, children: [text] };
    }
    return { type: 'element', tagName: 'a', properties: { href }, children: [text] };
}

function replaceImages(node: HastNode, insideLink: boolean) {
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
                children.push(imageLink(src, insideLink));
            }
            continue;
        }
        replaceImages(child, insideLink || (child.type === 'element' && child.tagName === 'a'));
        children.push(child);
    }
    node.children = children;
}

export function rehypeImagesToLinks() {
    return (tree: HastNode) => replaceImages(tree, false);
}

// Streamdown の既定（raw → sanitize → harden）の、sanitize と harden の間に上を挟む。
// harden は画像を 1 つも許さない形にして、上で取りこぼしたものも読み込まない（念のため）
const [harden, hardenOptions] = defaultRehypePlugins.harden as [Plugin, Record<string, unknown>];

export const rehypePlugins: PluggableList = [
    defaultRehypePlugins.raw,
    defaultRehypePlugins.sanitize,
    rehypeImagesToLinks as Pluggable,
    [harden, { ...hardenOptions, allowedImagePrefixes: [], allowDataImages: false, imageBlockPolicy: 'remove' }],
];
