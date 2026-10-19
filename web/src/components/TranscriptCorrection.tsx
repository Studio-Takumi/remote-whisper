import { type RefObject, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { type CorrectionLine, countInLines, rightProblem, selectionProblem } from '@/corrections';
import { useAppStore } from '@/store';
import { isSubmitKey } from '@/terms';
import type { TranscriptLine } from '@/types';

// 入力欄の幅（px）。画面の端からはみ出さないように寄せるのに使う
const WIDTH = 288;

// 選んだ文字列と、その場所
type Picked = { wrong: string; index: number; top: number; left: number; below: boolean };

// 文字起こしの文字を選ぶと、選んだ範囲の近くに出す入力欄（#176）。正しい語に直して Enter で決め、
// 置き換わる件数を見せてから「全部」か「この行だけ」を選ぶ。スマホでは、ブラウザが選んだ範囲の
// 上に出すメニューと重ならないよう、範囲の下に出す
export function TranscriptCorrection({
    container,
    sessionId,
    lines,
    target,
}: {
    // 文字起こしの本文を囲む要素（この中で選んだときだけ出す）
    container: RefObject<HTMLElement | null>;
    sessionId: string;
    // いま出している行（件数を数える）
    lines: TranscriptLine[];
    // いま出している文字起こし（リアルタイムか、浄書済みのどの版か）
    target: Omit<CorrectionLine, 'index'>;
}) {
    const addCorrection = useAppStore((s) => s.addCorrection);
    const [picked, setPicked] = useState<Picked | null>(null);
    const [right, setRight] = useState('');
    const [confirming, setConfirming] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    // 入力欄を触り始めたら、選ぶ範囲が消えても（入力欄に移ると消える）閉じない
    const engaged = useRef(false);
    const box = useRef<HTMLDivElement>(null);

    const close = () => {
        engaged.current = false;
        setPicked(null);
        setConfirming(false);
        setProblem(null);
    };

    // 文字を選んだら出す。選び直している間（スマホで範囲の端を動かしている間）は、出したまま追う
    useEffect(() => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onChange = () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                if (engaged.current) {
                    return;
                }
                const next = readSelection(container.current);
                setPicked(next);
                if (next) {
                    setRight(next.wrong);
                    setConfirming(false);
                    setProblem(null);
                }
            }, 200);
        };
        document.addEventListener('selectionchange', onChange);
        return () => {
            clearTimeout(timer);
            document.removeEventListener('selectionchange', onChange);
        };
    }, [container]);

    // 入力欄を触ったあとは、外を押すか Esc で閉じる
    useEffect(() => {
        if (!picked) {
            return;
        }
        const onDown = (e: PointerEvent) => {
            if (engaged.current && !box.current?.contains(e.target as Node)) {
                close();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                close();
            }
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [picked]);

    if (!picked) {
        return null;
    }

    const value = right.trim();
    const n = countInLines(lines, picked.wrong, value);

    const decide = () => {
        const reason = rightProblem(picked.wrong, value);
        setProblem(reason);
        if (!reason) {
            setConfirming(true);
        }
    };

    const apply = async (onlyThisLine: boolean) => {
        setBusy(true);
        try {
            const ok = await addCorrection(sessionId, {
                from: picked.wrong,
                to: value,
                line: onlyThisLine ? { ...target, index: picked.index } : null,
            });
            if (ok) {
                toast.success(`「${picked.wrong}」を「${value}」に置き換え、用語に足しました`);
                document.getSelection()?.removeAllRanges();
                close();
            }
        } finally {
            setBusy(false);
        }
    };

    const half = Math.min(WIDTH, window.innerWidth - 16) / 2;
    const left = Math.min(Math.max(picked.left, half + 8), window.innerWidth - half - 8);

    return createPortal(
        <div
            ref={box}
            role='dialog'
            aria-label='選んだ文字を置き換える'
            className='absolute z-50 flex flex-col gap-2 rounded-lg border bg-popover p-2 text-sm text-popover-foreground shadow-md'
            style={{
                top: picked.top,
                left,
                width: half * 2,
                transform: picked.below ? 'translateX(-50%)' : 'translate(-50%, -100%)',
            }}
            onPointerDown={() => {
                engaged.current = true;
            }}
            onFocus={() => {
                engaged.current = true;
            }}
        >
            {confirming ? (
                <>
                    <p>
                        このセッションの {n} 箇所を『{value}』に置き換えます
                    </p>
                    <div className='flex flex-wrap justify-end gap-1.5'>
                        <Button size='sm' disabled={busy} onClick={() => void apply(false)}>
                            全部
                        </Button>
                        <Button size='sm' variant='outline' disabled={busy} onClick={() => void apply(true)}>
                            この行だけ
                        </Button>
                        <Button size='sm' variant='ghost' disabled={busy} onClick={close}>
                            やめる
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <label className='text-xs text-muted-foreground' htmlFor='correction-right'>
                        「{picked.wrong}」を正しい語に直して Enter
                    </label>
                    <Input
                        id='correction-right'
                        className='h-8'
                        value={right}
                        onChange={(e) => setRight(e.target.value)}
                        onKeyDown={(e) => {
                            // 変換の確定の Enter では決めない
                            if (isSubmitKey({ key: e.key, isComposing: e.nativeEvent.isComposing })) {
                                e.preventDefault();
                                decide();
                            }
                        }}
                    />
                    {problem && (
                        <p role='alert' className='text-xs text-destructive'>
                            {problem}
                        </p>
                    )}
                </>
            )}
        </div>,
        document.body,
    );
}

// 文字起こしの 1 行の本文の中で選んだ文字列と、その場所。置き換えに使えない選び方なら null
function readSelection(container: HTMLElement | null): Picked | null {
    const selection = document.getSelection();
    if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }
    const range = selection.getRangeAt(0);
    const start = elementOf(range.startContainer)?.closest('[data-correctable]');
    const end = elementOf(range.endContainer)?.closest('[data-correctable]');
    // 行をまたいだ・時刻や話者の札まで選んだときは出さない
    if (!start || start !== end || !container.contains(start)) {
        return null;
    }
    const row = start.closest<HTMLElement>('[data-line-index]');
    const wrong = selection.toString().trim();
    if (!row || selectionProblem(wrong)) {
        return null;
    }
    const rect = range.getBoundingClientRect();
    // 指で操作する端末では、選んだ範囲の上にブラウザのメニューが出るので、下（範囲の端のつまみより下）に出す
    const below = window.matchMedia('(pointer: coarse)').matches;
    return {
        wrong,
        index: Number(row.dataset.lineIndex),
        top: (below ? rect.bottom + 28 : rect.top - 8) + window.scrollY,
        left: rect.left + rect.width / 2 + window.scrollX,
        below,
    };
}

function elementOf(node: Node): Element | null {
    return node instanceof Element ? node : node.parentElement;
}
