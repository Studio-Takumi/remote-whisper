import { useState } from 'react';

import {
    ChevronRightIcon,
    FileTextIcon,
    FolderIcon,
    FolderOpenIcon,
    HardDriveIcon,
    type LucideIcon,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { listDirs, listFiles } from '@/mock';

// 参考資料にするファイルを選ぶ。選べるのは「読み込めるフォルダ」の中の、読み込める拡張子のファイルだけ（spec 7.3 節）
export function MaterialPickerDialog({
    open,
    onOpenChange,
    roots,
    extensions,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    roots: string[];
    extensions: string[];
    onCreate: (materials: string[]) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className='sm:max-w-lg'>
                <DialogHeader>
                    <DialogTitle>参考資料を選ぶ</DialogTitle>
                    <DialogDescription>
                        選んだ資料から、文字起こし用の用語リストと、要約用のコンテキストを作ります。作成には数分かかります。
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに選び直せる */}
                <Picker
                    roots={roots}
                    extensions={extensions}
                    onCreate={(materials) => {
                        onCreate(materials);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

function joinPath(root: string, segments: string[]) {
    return [root.replace(/\\$/, ''), ...segments].join('\\');
}

function Picker({
    roots,
    extensions,
    onCreate,
}: {
    roots: string[];
    extensions: string[];
    onCreate: (materials: string[]) => void;
}) {
    const [selected, setSelected] = useState<string[]>([]);

    function toggle(path: string) {
        setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));
    }

    return (
        <>
            <div className='h-72 overflow-y-auto rounded-lg border p-1'>
                {roots.map((root) => (
                    <FolderNode
                        key={root}
                        root={root}
                        segments={[]}
                        label={root}
                        extensions={extensions}
                        selected={selected}
                        onToggle={toggle}
                        defaultOpen
                    />
                ))}
            </div>
            <p className='text-xs text-muted-foreground'>読み込める拡張子：{extensions.join(', ')}</p>
            <DialogFooter className='sm:items-center'>
                <p className='mr-auto text-xs text-muted-foreground'>{selected.length} 件選択中</p>
                <DialogClose asChild>
                    <Button variant='outline'>キャンセル</Button>
                </DialogClose>
                <Button disabled={selected.length === 0} onClick={() => onCreate([...selected].sort())}>
                    この資料で作成
                </Button>
            </DialogFooter>
        </>
    );
}

// フォルダの1行。押すと中身を開く・閉じる。中のファイルにはチェックボックスを付ける
function FolderNode({
    root,
    segments,
    label,
    extensions,
    selected,
    onToggle,
    defaultOpen = false,
}: {
    root: string;
    segments: string[];
    label: string;
    extensions: string[];
    selected: string[];
    onToggle: (path: string) => void;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    // 本物の API では、開いたときに /api/fs で中身を取りに行く
    const dirs = listDirs(root, segments);
    const files = listFiles(root, segments, extensions);
    const empty = dirs.length === 0 && files.length === 0;
    const Icon: LucideIcon = segments.length === 0 ? HardDriveIcon : open && !empty ? FolderOpenIcon : FolderIcon;

    return (
        <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
                <button className='flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted'>
                    <ChevronRightIcon
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''} ${empty ? 'invisible' : ''}`}
                    />
                    <Icon className='size-4 shrink-0 text-muted-foreground' />
                    <span className='truncate'>{label}</span>
                </button>
            </CollapsibleTrigger>
            {!empty && (
                <CollapsibleContent className='ml-3.5 border-l pl-1.5'>
                    {dirs.map((name) => (
                        <FolderNode
                            key={name}
                            root={root}
                            segments={[...segments, name]}
                            label={name}
                            extensions={extensions}
                            selected={selected}
                            onToggle={onToggle}
                        />
                    ))}
                    {files.map((name) => {
                        const path = joinPath(root, [...segments, name]);
                        return (
                            <label
                                key={name}
                                className='flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted'
                            >
                                <Checkbox checked={selected.includes(path)} onCheckedChange={() => onToggle(path)} />
                                <FileTextIcon className='size-4 shrink-0 text-muted-foreground' />
                                <span className='truncate'>{name}</span>
                            </label>
                        );
                    })}
                </CollapsibleContent>
            )}
        </Collapsible>
    );
}
