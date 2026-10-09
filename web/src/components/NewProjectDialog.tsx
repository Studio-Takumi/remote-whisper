import { useState } from 'react';

import { ChevronRightIcon, FolderIcon, FolderOpenIcon, HardDriveIcon, type LucideIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { listDirs } from '@/mock';

// プロジェクトにするフォルダを選ぶ。選べるのは設定の「読み込めるフォルダ」の中だけ（spec 7.3 節）
export function NewProjectDialog({
    open,
    onOpenChange,
    roots,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    roots: string[];
    onCreate: (path: string) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className='sm:max-w-lg'>
                <DialogHeader>
                    <DialogTitle>新規プロジェクト作成</DialogTitle>
                    <DialogDescription>
                        プロジェクトにするフォルダを選んでください。録音はプロジェクトごとにまとめられ、最終の要約のコピーはこのフォルダに置かれます。
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに選び直せる */}
                <FolderPicker
                    roots={roots}
                    onCreate={(path) => {
                        onCreate(path);
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

function FolderPicker({ roots, onCreate }: { roots: string[]; onCreate: (path: string) => void }) {
    const [selected, setSelected] = useState<string | null>(null);

    return (
        <>
            <div className='h-72 overflow-y-auto rounded-lg border p-1'>
                {roots.length === 0 ? (
                    <div className='flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground'>
                        読み込めるフォルダが設定されていません。設定の「参考資料」から追加してください。
                    </div>
                ) : (
                    roots.map((root) => (
                        <FolderNode
                            key={root}
                            root={root}
                            segments={[]}
                            label={root}
                            selected={selected}
                            onSelect={setSelected}
                            defaultOpen
                        />
                    ))
                )}
            </div>

            <DialogFooter className='sm:items-center'>
                <p className='mr-auto min-w-0 truncate text-xs text-muted-foreground'>
                    {selected ?? 'フォルダを選んでください'}
                </p>
                <DialogClose asChild>
                    <Button variant='outline'>キャンセル</Button>
                </DialogClose>
                <Button disabled={selected === null} onClick={() => selected && onCreate(selected)}>
                    このフォルダで作成
                </Button>
            </DialogFooter>
        </>
    );
}

// ツリーの1行。押すと選択して、子フォルダを開く・閉じる（sidebar-11 のファイルツリーと同じ作り）
function FolderNode({
    root,
    segments,
    label,
    selected,
    onSelect,
    defaultOpen = false,
}: {
    root: string;
    segments: string[];
    label: string;
    selected: string | null;
    onSelect: (path: string) => void;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const path = joinPath(root, segments);
    // 本物の API では、開いたときに /api/fs で子を取りに行く
    const children = listDirs(root, segments);
    const isRoot = segments.length === 0;
    const Icon: LucideIcon = isRoot ? HardDriveIcon : open && children.length > 0 ? FolderOpenIcon : FolderIcon;

    return (
        <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
                <button
                    className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted ${selected === path ? 'bg-muted font-medium' : ''}`}
                    onClick={() => onSelect(path)}
                >
                    <ChevronRightIcon
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''} ${children.length === 0 ? 'invisible' : ''}`}
                    />
                    <Icon className='size-4 shrink-0 text-muted-foreground' />
                    <span className='truncate'>{label}</span>
                </button>
            </CollapsibleTrigger>
            {children.length > 0 && (
                <CollapsibleContent className='ml-3.5 border-l pl-1.5'>
                    {children.map((name) => (
                        <FolderNode
                            key={name}
                            root={root}
                            segments={[...segments, name]}
                            label={name}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    ))}
                </CollapsibleContent>
            )}
        </Collapsible>
    );
}
