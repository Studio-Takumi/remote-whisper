import { type Ref, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { LocateFixedIcon } from 'lucide-react';

import type { TranscriptLine } from '@/api/types';
import { type LivePartial, useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { sourceColor, sourceLabel, sourceTitle } from '@/features/session/sources';
import { isScrolledToBottom, scrollToBottom } from '@/lib/scroll';

// 録音の再生位置（#122）。index は再生位置に当たる行（まだ当たる行がなければ null）。
// seeks はシークした回数（シークしたら、また再生位置を追う）
export type Playback = { index: number | null; playing: boolean; seeks: number };

// 文字起こしの本文。確定した行（final）と、文字起こし中の区間（partial）を出す（spec/flows.md 6.2・spec/ui.md 8）
export function Transcript({
    sessionId,
    lines,
    partials,
    follow = true,
    onSeek,
    playback,
    sourceNames = NO_NAMES,
    defaultSource,
}: {
    sessionId: string;
    lines: TranscriptLine[];
    // 文字起こし中の区間。音源が 2 つ以上なら音源ごとに 1 つ（#356）
    partials: LivePartial[];
    follow?: boolean;
    // 行の時刻を押したとき（録音を再生できるときだけ渡す）
    onSeek?: (time: string) => void;
    // 録音を再生しているとき、その位置の行を目立たせて追う（#122）
    playback?: Playback | null;
    // 音源の名前（音源 ID ごと。行の音源の札の title に出す。#357）
    sourceNames?: Record<number, string | null>;
    // 音源の分からない行の音源（音源が 2 つ以上のセッションで 1。ほかの端末が参加する前の行は音源が付かないので、
    // 主の音源とみなす。spec/flows.md 6.16）。音源が 1 つのセッションでは渡さない（札を出さない）
    defaultSource?: number;
}) {
    // 文字送りで伸びた分も追う（PartialLine が伸びるたびに知らせる）
    const [typed, setTyped] = useState(0);
    const onTyped = useCallback(() => setTyped((n) => n + 1), []);
    const partialKey = partials.map((p) => `${p.segment}:${p.committed}:${p.tentative}`).join('|');
    useStickToBottom(`${lines.length}:${partialKey}:${typed}`, follow);
    const { outer, inner } = useKeepHeight(sessionId, `${lines.length}:${partialKey}:${typed}`);
    const active = playback?.index ?? null;
    const { activeRow, following, followAgain } = useFollowPlayback(active, playback?.seeks ?? 0, !!playback?.playing);

    return (
        <div ref={outer}>
            {/* 行の間隔は親（TabsContent）と同じ gap-2 */}
            <div ref={inner} className='flex flex-col gap-2'>
                {lines.map((line, i) => {
                    const source = line.source ?? defaultSource;
                    return (
                        <Line
                            key={`${line.time}-${i}`}
                            index={i}
                            line={line}
                            active={i === active}
                            rowRef={i === active ? activeRow : undefined}
                            onSeek={onSeek}
                            source={source}
                            sourceName={source !== undefined ? sourceNames[source] : undefined}
                        />
                    );
                })}
                {partials.map((partial) => {
                    const source = partial.source ?? defaultSource;
                    return (
                        <PartialLine
                            key={partial.source ?? 0}
                            partial={partial}
                            onTyped={onTyped}
                            source={source}
                            sourceName={source !== undefined ? sourceNames[source] : undefined}
                        />
                    );
                })}
            </div>
            {active !== null && !following && (
                // 自分でスクロールして再生位置から離れたとき。本文の列の中央、下のマイクのボタンより上に貼り付ける
                <div className='pointer-events-none sticky bottom-44 z-20 flex justify-center'>
                    <Button size='sm' className='pointer-events-auto rounded-full shadow-md' onClick={followAgain}>
                        <LocateFixedIcon />
                        再生位置に戻る
                    </Button>
                </div>
            )}
        </div>
    );
}

// 文字起こし中の区間。確定した部分を文字送りで出し、追いついていない分は未確定の部分と同じく薄く出す
function PartialLine({
    partial,
    onTyped,
    source,
    sourceName,
}: {
    partial: LivePartial;
    onTyped: () => void;
    source?: number;
    sourceName?: string | null;
}) {
    const committed = useTypewriter(partial.committed, partial.segment);
    const pending = partial.committed.slice(committed.length) + partial.tentative;
    useEffect(() => {
        onTyped();
    }, [committed, onTyped]);
    return (
        <div className='flex gap-3'>
            {/* 時刻の列と幅をそろえるため、見えない時刻を置く */}
            <span aria-hidden className='invisible shrink-0 font-mono text-xs leading-6'>
                00:00:00
            </span>
            {source !== undefined && <SourceBadge id={source} name={sourceName} />}
            <p className='leading-6'>
                {committed}
                <span className='text-muted-foreground/70'>{pending}</span>
            </p>
        </div>
    );
}

// 1行。長い文字起こし（1時間で千行ほど）でも、再生位置が変わったときに描き直すのは前後の2行だけにする
const Line = memo(function Line({
    index,
    line,
    active,
    rowRef,
    onSeek,
    source,
    sourceName,
}: {
    index: number;
    line: TranscriptLine;
    active: boolean;
    rowRef?: Ref<HTMLDivElement>;
    onSeek?: (time: string) => void;
    source?: number;
    sourceName?: string | null;
}) {
    return (
        <div
            ref={rowRef}
            // 文字を選んで置き換えるときに、どの行か見分ける（#176）
            data-line-index={index}
            aria-current={active ? 'true' : undefined}
            // 目立たせても行の位置がずれないよう、余白の分を外側に出す
            className={`-mx-2 flex gap-3 rounded-md px-2 transition-colors ${active ? 'bg-primary/10 ring-1 ring-primary/30 dark:bg-primary/15 dark:ring-primary/40' : ''}`}
        >
            {onSeek ? (
                // 押すと、その位置から録音を再生する
                <button
                    className='shrink-0 self-start rounded font-mono text-xs leading-6 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline'
                    aria-label={`${line.time} から再生`}
                    onClick={() => onSeek(line.time)}
                >
                    {line.time}
                </button>
            ) : (
                <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>{line.time}</span>
            )}
            {source !== undefined && <SourceBadge id={source} name={sourceName} />}
            <LineText text={line.text} />
        </div>
    );
});

const NO_NAMES: Record<number, string | null> = {};

// 行の音源の札（音源が 2 つ以上のセッションだけ。#357）。どの音源の声として文字になったか。
// 話者の札（塗りの四角）と取り違えないよう、枠線の丸い札にする（音源は話者ではない）。
// 時刻の横に置き、置き換え（#176）で選ぶ文字には入れない
export function SourceBadge({ id, name }: { id: number; name?: string | null }) {
    const title = sourceTitle(id, name);
    return (
        <span
            role='img'
            title={title}
            aria-label={title}
            className={`mt-0.5 inline-flex h-5 shrink-0 items-center self-start rounded-full border px-1.5 text-xs whitespace-nowrap tabular-nums ${sourceColor(id)}`}
        >
            {sourceLabel(id)}
        </span>
    );
}

// 置き換え（#176）に使えるのは data-correctable の中の文字だけ（時刻と話者の札は選んでも使わない）
// 最終の文字起こし（#121）で話者を分けた行は「話者 1: …」で始まる。話者は色付きの札にする
const SPEAKER_RE = /^話者 (\d+): (.*)$/s;
const SPEAKER_COLORS = [
    'bg-sky-500/15 text-sky-800 dark:text-sky-300',
    'bg-amber-500/15 text-amber-800 dark:text-amber-300',
    'bg-emerald-500/15 text-emerald-800 dark:text-emerald-300',
    'bg-fuchsia-500/15 text-fuchsia-800 dark:text-fuchsia-300',
    'bg-rose-500/15 text-rose-800 dark:text-rose-300',
    'bg-indigo-500/15 text-indigo-800 dark:text-indigo-300',
];

function LineText({ text }: { text: string }) {
    // 全体設定の display.showSpeakers（#146）がオフなら、札は出さず文だけを出す
    const showSpeakers = useAppStore((s) => s.settings.display.showSpeakers ?? false);
    const m = SPEAKER_RE.exec(text);
    if (!m) {
        return (
            <p className='leading-6'>
                <span data-correctable>{text}</span>
            </p>
        );
    }
    if (!showSpeakers) {
        return (
            <p className='leading-6'>
                <span data-correctable>{m[2]}</span>
            </p>
        );
    }
    const color = SPEAKER_COLORS[(Number(m[1]) - 1) % SPEAKER_COLORS.length];
    return (
        <p className='leading-6'>
            <span className={`mr-1.5 rounded px-1.5 py-0.5 text-xs whitespace-nowrap ${color}`}>話者 {m[1]}</span>
            <span data-correctable>{m[2]}</span>
        </p>
    );
}

// 再生位置の行が見えるように追う（#122）。自分でスクロールしたら追うのをやめ、「再生位置に戻る」で戻す。
// シークしたら（時刻を押した・再生バーで動かした）、また追う
function useFollowPlayback(active: number | null, seeks: number, playing: boolean) {
    const activeRow = useRef<HTMLDivElement>(null);
    const [stopped, setStopped] = useState({ seeks, stopped: false });
    // シークしたら追い直す（シークの回数が変わったら、やめていたことを忘れる）
    const following = stopped.seeks !== seeks || !stopped.stopped;

    // 再生中に、ホイール・タッチ・キーでスクロールしたら追うのをやめる
    // （scroll イベントは自分で動かしたときにも来るので、人の操作だけを見る）
    useEffect(() => {
        if (!playing) {
            return;
        }
        const stop = (e: Event) => {
            if (scrollsPage(e.target)) {
                setStopped({ seeks, stopped: true });
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (
                ['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) &&
                !isEditable(e.target)
            ) {
                stop(e);
            }
        };
        window.addEventListener('wheel', stop, { passive: true });
        window.addEventListener('touchmove', stop, { passive: true });
        window.addEventListener('keydown', onKey);
        return () => {
            window.removeEventListener('wheel', stop);
            window.removeEventListener('touchmove', stop);
            window.removeEventListener('keydown', onKey);
        };
    }, [playing, seeks]);

    useEffect(() => {
        if (active !== null && following) {
            activeRow.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }, [active, following]);

    const followAgain = useCallback(() => setStopped({ seeks, stopped: false }), [seeks]);
    return { activeRow, following, followAgain };
}

// ページのスクロールになる操作か。ダイアログ・選択肢の一覧・再生バーの中の操作は、ページを動かさない
function scrollsPage(target: EventTarget | null) {
    return !(target instanceof Element && target.closest('[role="dialog"], [role="listbox"], [role="menu"], audio'));
}

// 文字を入力している・値を選んでいるところ（矢印キーなどはその中で使う）
function isEditable(target: EventTarget | null) {
    return (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
    );
}

// 確定した文字を少しずつ出す（文字送りの演出）。key が変わったら（次の区間になったら）最初から
function useTypewriter(text: string, key: number) {
    const [shown, setShown] = useState({ key, length: 0 });
    const length = shown.key === key ? Math.min(shown.length, text.length) : 0;

    useEffect(() => {
        if (length >= text.length) {
            return;
        }
        // 残りが多いほど速く出して、次の partial が来るまでに追いつくようにする
        const timer = setTimeout(() => {
            const step = Math.max(1, Math.ceil((text.length - length) / 8));
            setShown({ key, length: Math.min(text.length, length + step) });
        }, 30);
        return () => clearTimeout(timer);
    }, [key, length, text]);

    return text.slice(0, length);
}

// 文字起こしの高さを、同じセッションのあいだは縮めない（#89）
// 未確定部分は書き換わるたびに短くなることもあり、partial の行は final の行に置き換わったり消えたりする。
// 一番下を見ているときにページが縮むと位置が詰まり、伸びてまた下へ飛ぶ、を繰り返して揺れて見えるため。
// 余る高さは partial の 1 行分ほどで、次の行で埋まる
// 外側の箱に min-height を付け、内側の箱（中身）の高さを測る。min-height を外して測ると、
// その瞬間にページが縮んでスクロールの位置が詰まってしまう
// key はセッション（変わったら測り直す）、content は中身（変わったら高さを測る）
function useKeepHeight(key: string, content: string) {
    const outer = useRef<HTMLDivElement>(null);
    const inner = useRef<HTMLDivElement>(null);
    const kept = useRef({ key, width: 0, height: 0 });

    const measure = useCallback(() => {
        if (!outer.current || !inner.current) {
            return;
        }
        // 幅が変わったら（画面を回した・ウィンドウの大きさを変えた）折り返しが変わるので、測り直す
        const width = inner.current.offsetWidth;
        if (kept.current.key !== key || kept.current.width !== width) {
            kept.current = { key, width, height: 0 };
        }
        kept.current.height = Math.max(kept.current.height, inner.current.offsetHeight);
        outer.current.style.minHeight = `${kept.current.height}px`;
    }, [key]);

    useLayoutEffect(measure, [measure, content]);

    useEffect(() => {
        if (!inner.current) {
            return;
        }
        const observer = new ResizeObserver(measure);
        observer.observe(inner.current);
        return () => observer.disconnect();
    }, [measure]);

    return { outer, inner };
}

// 新しい行が来たらページの一番下までスクロールする。ユーザーが上のほうを見ているときは追わない
// （下のマイクのボタンは sticky だが、ページの最後に場所を取るので、一番下なら最後の行は隠れない）
// trigger は中身が変わったら動かすためのキー。ページが伸びたときだけ動かす（縮んだときに動かすと揺れて見える。#89）
// follow は出したときに追うかどうか。タブを切り替えて戻ってきたときは、前に一番下にいたときだけ追う（#78）
function useStickToBottom(trigger: string, follow: boolean) {
    const atBottom = useRef(follow);
    const lastHeight = useRef(0);

    useEffect(() => {
        const onScroll = () => {
            atBottom.current = isScrolledToBottom();
        };
        window.addEventListener('scroll', onScroll, { passive: true });
        return () => window.removeEventListener('scroll', onScroll);
    }, []);

    useEffect(() => {
        const height = document.documentElement.scrollHeight;
        const grew = height > lastHeight.current;
        lastHeight.current = height;
        if (trigger && grew && atBottom.current) {
            scrollToBottom();
        }
    }, [trigger]);
}
