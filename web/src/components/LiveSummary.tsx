import { useLayoutEffect, useRef, useState } from 'react';

import { ChevronRightIcon } from 'lucide-react';

import { Markdown } from '@/components/Markdown';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

// 途中の要約の表示（spec 6.4・8）。サーバーは長くなると「## ここまでの概要」と、
// 時刻の範囲を見出し（## 00:00:00〜00:12:34）にした区間ごとの要約を並べて送る（#93）。
// 確定した区間（終わりの時刻があるもの）は畳んでおき、開けば読める。続いている区間（00:12:34〜）は開いておく
// 見出しのない要約（短い録音・前のサーバーで作ったもの）は、そのまま出す
const OVERVIEW = 'ここまでの概要';
const CLOSED = /^\d{2}:\d{2}:\d{2}〜\d{2}:\d{2}:\d{2}$/;

type Block = { heading: string; body: string };

export function LiveSummary({ text, streaming = false }: { text: string; streaming?: boolean }) {
    const blocks = splitSections(text);
    // 開け閉めした区間（見出し → 開いているか）。更新が届いても覚えておく
    const [toggled, setToggled] = useState<Record<string, boolean>>({});
    const container = useAnchoredScroll(text);

    if (!blocks) {
        return <Markdown streaming={streaming}>{text}</Markdown>;
    }
    return (
        // 読んでいる位置は useAnchoredScroll で保つので、ブラウザのスクロールの固定は切る
        <div ref={container} className='flex flex-col gap-2 [overflow-anchor:none]'>
            {blocks.map((block) => {
                if (block.heading === OVERVIEW) {
                    return (
                        <section key={block.heading} data-live-section={block.heading}>
                            <h2 className='mb-1 text-sm font-semibold'>{OVERVIEW}</h2>
                            <Markdown>{block.body}</Markdown>
                        </section>
                    );
                }
                const open = toggled[block.heading] ?? !CLOSED.test(block.heading);
                return (
                    <Collapsible
                        key={block.heading}
                        open={open}
                        onOpenChange={(value) => setToggled((t) => ({ ...t, [block.heading]: value }))}
                        data-live-section={block.heading}
                        className='rounded-lg border'
                    >
                        <CollapsibleTrigger className='flex w-full items-center gap-1.5 px-3 py-2 text-left font-semibold tabular-nums hover:bg-muted/50'>
                            <ChevronRightIcon
                                className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`}
                            />
                            {block.heading}
                            {!CLOSED.test(block.heading) && (
                                <span className='text-xs font-normal text-muted-foreground'>（続いている区間）</span>
                            )}
                        </CollapsibleTrigger>
                        <CollapsibleContent className='px-3 pb-3'>
                            <Markdown>{block.body}</Markdown>
                        </CollapsibleContent>
                    </Collapsible>
                );
            })}
        </div>
    );
}

// 「## 見出し」で区切る。最初が「ここまでの概要」でなければ、区間に分かれていない要約とみなして null
function splitSections(text: string): Block[] | null {
    const blocks: Block[] = [];
    for (const line of text.split('\n')) {
        const heading = /^## (.+)$/.exec(line);
        if (heading) {
            blocks.push({ heading: heading[1].trim(), body: '' });
        } else if (blocks.length > 0) {
            blocks[blocks.length - 1].body += `${line}\n`;
        } else if (line.trim()) {
            return null;
        }
    }
    return blocks[0]?.heading === OVERVIEW ? blocks : null;
}

// 要約が更新されても、読んでいる区間の位置が画面の中でずれないようにする（#93）
// 画面の上の端に見えている区間を覚えておき、更新の後にその区間が同じ位置に来るようにスクロールし直す。
// 概要が伸び縮みしても、下の区間を読んでいる人の位置が動かない
function useAnchoredScroll(text: string) {
    const container = useRef<HTMLDivElement>(null);
    const anchor = useRef<{ key: string; top: number } | null>(null);

    // スクロールするたびに、今見えている区間を覚える
    useLayoutEffect(() => {
        const remember = () => {
            anchor.current = findAnchor(container.current);
        };
        remember();
        window.addEventListener('scroll', remember, { passive: true });
        return () => window.removeEventListener('scroll', remember);
    }, []);

    // 更新の後、覚えていた区間が同じ位置に来るように戻す
    useLayoutEffect(() => {
        const saved = anchor.current;
        const el = saved && container.current?.querySelector(`[data-live-section="${CSS.escape(saved.key)}"]`);
        if (saved && el) {
            const diff = el.getBoundingClientRect().top - saved.top;
            if (Math.abs(diff) >= 1) {
                window.scrollBy({ top: diff });
            }
        }
        anchor.current = findAnchor(container.current);
    }, [text]);

    return container;
}

// 上に貼り付けたバー（上のバー・タブ・再生バー）のおおよその高さ。これより下が読める範囲
const STICKY_TOP = 120;

// 目印にする区間。読める範囲の上から 1/3 のあたり（読んでいるところ）にかかっている区間。
// その区間が同じ位置にあれば、上の概要が伸び縮みしても、読んでいる文が動かない
function findAnchor(root: HTMLElement | null) {
    if (!root) {
        return null;
    }
    // 一番上にいるとき（概要を見ているとき）は、ずらさない
    if (window.scrollY <= 0) {
        return null;
    }
    const reading = STICKY_TOP + (window.innerHeight - STICKY_TOP) / 3;
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
