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
import { useDirListing } from '@/hooks/useDirListing';

// プロジェクトにするフォルダを選ぶ。選べるのは設定の「読み込めるフォルダ」の中だけ（spec/api.md 7.3 節）
export function NewProjectDialog({
    open,
    onOpenChange,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreate: (path: string) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className='sm:max-w-lg'>
                <DialogHeader>
                    <DialogTitle>新規プロジェクト作成</DialogTitle>
                    <DialogDescription>
                        プロジェクトにするフォルダを選んでください。最終要約のコピーはこのフォルダに置かれます
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに選び直せる */}
                <FolderPicker
                    onCreate={(path) => {
                        onCreate(path);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

function FolderPicker({ onCreate }: { onCreate: (path: string) => void }) {
    const [selected, setSelected] = useState<string | null>(null);
    // 一番上は、読み込めるフォルダ（materials.roots）の一覧
    const { listing, error } = useDirListing(null);
    const roots = listing?.dirs ?? [];

    return (
        <>
            <div className='h-72 overflow-y-auto rounded-lg border p-1'>
                {error ? (
                    <Message>フォルダの一覧を取れません: {error}</Message>
                ) : !listing ? (
                    <Message>読み込んでいます…</Message>
                ) : roots.length === 0 ? (
                    <Message>読み込めるフォルダがありません。設定の「参考資料」で追加してください</Message>
                ) : (
                    roots.map((root) => (
                        <FolderNode
                            key={root.path}
                            path={root.path}
                            label={root.name}
                            isRoot
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

function Message({ children }: { children: React.ReactNode }) {
    return (
        <div className='flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground'>
            {children}
        </div>
    );
}

// ツリーの1行。押すと選択して、子フォルダを開く・閉じる（sidebar-11 のファイルツリーと同じ作り）
// 子フォルダは、開いたときに GET /api/fs で取りに行く
function FolderNode({
    path,
    label,
    isRoot = false,
    selected,
    onSelect,
    defaultOpen = false,
}: {
    path: string;
    label: string;
    isRoot?: boolean;
    selected: string | null;
    onSelect: (path: string) => void;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const { listing } = useDirListing(path, open);
    // まだ取っていないときは、子がある前提で ▶ を出す
    const children = listing?.dirs ?? [];
    const empty = listing !== null && children.length === 0;
    const Icon: LucideIcon = isRoot ? HardDriveIcon : open && !empty ? FolderOpenIcon : FolderIcon;

    return (
        <Collapsible open={open} onOpenChange={setOpen}>
            <CollapsibleTrigger asChild>
                <button
                    className={`flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted ${selected === path ? 'bg-muted font-medium' : ''}`}
                    onClick={() => onSelect(path)}
                >
                    <ChevronRightIcon
                        className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''} ${empty ? 'invisible' : ''}`}
                    />
                    <Icon className='size-4 shrink-0 text-muted-foreground' />
                    <span className='truncate'>{label}</span>
                </button>
            </CollapsibleTrigger>
            {children.length > 0 && (
                <CollapsibleContent className='ml-3.5 border-l pl-1.5'>
                    {children.map((child) => (
                        <FolderNode
                            key={child.path}
                            path={child.path}
                            label={child.name}
                            selected={selected}
                            onSelect={onSelect}
                        />
                    ))}
                </CollapsibleContent>
            )}
        </Collapsible>
    );
}
