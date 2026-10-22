import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DEFAULT_MIC_SHORTCUT, captureShortcut, formatShortcut, isMacPlatform } from '@/shortcut';

// キーの組み合わせを決める入力欄（#236）。押してからキーを押すと、その組み合わせが入る。
// 修飾キー（Ctrl・Alt・Shift・Meta）を 1 つ以上含むものだけ受け付ける。Esc でやめる。
// 決めている間は data-shortcut-capture を付け、設定モーダルが Esc で閉じないようにする（SettingsDialog）
export function ShortcutInput({
    id,
    value,
    onChange,
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
}) {
    const [capturing, setCapturing] = useState(false);
    const [error, setError] = useState(false);
    // 決めている間に押したキーを離したとき、Space の keyup でボタンが押されたことにならないように
    const swallowKeyUp = useRef(false);
    const modifiers = isMacPlatform() ? '⌃・⌥・⇧・⌘' : 'Ctrl・Alt・Shift・Win';

    function onKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
        if (!capturing) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        swallowKeyUp.current = true;
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
            setCapturing(false);
            setError(false);
            return;
        }
        const result = captureShortcut(e.nativeEvent);
        if (result.kind === 'needsModifier') {
            setError(true);
        } else if (result.kind === 'combo') {
            onChange(result.combo);
            setCapturing(false);
            setError(false);
        }
    }

    const label = capturing ? 'キーを押してください…' : value === '' ? '使わない' : formatShortcut(value);

    return (
        <div className='flex flex-col items-start gap-1 md:items-end'>
            <div className='flex flex-wrap items-center gap-2'>
                <Button
                    id={id}
                    type='button'
                    variant='outline'
                    className={`min-w-28 font-mono ${capturing ? 'ring-2 ring-ring' : ''}`}
                    aria-live='polite'
                    data-shortcut-capture={capturing ? 'true' : undefined}
                    onClick={() => {
                        setCapturing((c) => !c);
                        setError(false);
                    }}
                    onKeyDown={onKeyDown}
                    onKeyUp={(e) => {
                        if (swallowKeyUp.current) {
                            e.preventDefault();
                            swallowKeyUp.current = false;
                        }
                    }}
                    onBlur={() => {
                        setCapturing(false);
                        setError(false);
                    }}
                >
                    {label}
                </Button>
                <Button
                    type='button'
                    variant='ghost'
                    size='sm'
                    disabled={value === DEFAULT_MIC_SHORTCUT}
                    onClick={() => onChange(DEFAULT_MIC_SHORTCUT)}
                >
                    既定に戻す
                </Button>
                <Button type='button' variant='ghost' size='sm' disabled={value === ''} onClick={() => onChange('')}>
                    使わない
                </Button>
            </div>
            {capturing && (
                <p className={`text-xs ${error ? 'text-destructive' : 'text-muted-foreground'}`}>
                    {error ? `${modifiers} のどれかと一緒に押してください` : 'Esc で取り消します'}
                </p>
            )}
        </div>
    );
}
