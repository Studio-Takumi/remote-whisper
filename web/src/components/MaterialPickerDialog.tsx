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
import { useDirListing } from '@/hooks/useDirListing';

// 参考資料にするファイルを選ぶ。選べるのは「読み込めるフォルダ」の中の、読み込める拡張子のファイルだけ（spec 7.3 節）
// 拡張子で絞るのはサーバー（GET /api/fs）。extensions は説明に出すだけ
export function MaterialPickerDialog({
    open,
    onOpenChange,
    extensions,
    onCreate,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
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

function Picker({ extensions, onCreate }: { extensions: string[]; onCreate: (materials: string[]) => void }) {
    const [selected, setSelected] = useState<string[]>([]);
    // 一番上は、読み込めるフォルダ（materials.roots）の一覧
    const { listing, error } = useDirListing(null);

    function toggle(path: string) {
        setSelected((s) => (s.includes(path) ? s.filter((p) => p !== path) : [...s, path]));
    }

    return (
        <>
            <div className='h-72 overflow-y-auto rounded-lg border p-1'>
                {error ? (
                    <Message>フォルダの一覧を取れません: {error}</Message>
                ) : !listing ? (
                    <Message>読み込んでいます…</Message>
                ) : listing.dirs.length === 0 ? (
                    <Message>読み込めるフォルダが設定されていません。設定の「参考資料」から追加してください。</Message>
                ) : (
                    listing.dirs.map((root) => (
                        <FolderNode
                            key={root.path}
                            path={root.path}
                            label={root.name}
                            isRoot
                            selected={selected}
                            onToggle={toggle}
                            defaultOpen
                        />
                    ))
                )}
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

function Message({ children }: { children: React.ReactNode }) {
    return (
        <div className='flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground'>
            {children}
        </div>
    );
}

// フォルダの1行。押すと中身を開く・閉じる。中のファイルにはチェックボックスを付ける
// 中身は、開いたときに GET /api/fs で取りに行く
function FolderNode({
    path,
    label,
    isRoot = false,
    selected,
    onToggle,
    defaultOpen = false,
}: {
    path: string;
    label: string;
    isRoot?: boolean;
    selected: string[];
    onToggle: (path: string) => void;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const { listing } = useDirListing(path, open);
    const dirs = listing?.dirs ?? [];
    const files = listing?.files ?? [];
    // まだ取っていないときは、中身がある前提で ▶ を出す
    const empty = listing !== null && dirs.length === 0 && files.length === 0;
    const Icon: LucideIcon = isRoot ? HardDriveIcon : open && !empty ? FolderOpenIcon : FolderIcon;

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
                    {dirs.map((child) => (
                        <FolderNode
                            key={child.path}
                            path={child.path}
                            label={child.name}
                            selected={selected}
                            onToggle={onToggle}
                        />
                    ))}
                    {files.map((file) => (
                        <label
                            key={file.path}
                            className='flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-sm hover:bg-muted'
                        >
                            <Checkbox
                                checked={selected.includes(file.path)}
                                onCheckedChange={() => onToggle(file.path)}
                            />
                            <FileTextIcon className='size-4 shrink-0 text-muted-foreground' />
                            <span className='truncate'>{file.name}</span>
                        </label>
                    ))}
                </CollapsibleContent>
            )}
        </Collapsible>
    );
}
