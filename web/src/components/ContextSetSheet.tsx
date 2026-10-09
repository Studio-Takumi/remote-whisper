import { useState } from 'react';

import { ChevronDownIcon, FileTextIcon, PlusIcon } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { MaterialPickerDialog } from '@/components/MaterialPickerDialog';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { type ContextSet, contextSetName } from '@/mock';
import { currentContextSelection, currentContextSets, currentProject, useAppStore } from '@/store';

const NONE = 'none';

const statusLabel: Record<ContextSet['status'], string> = {
    generating: '（作成中…）',
    ready: '',
    failed: '（失敗）',
};

// 参考資料セットを選ぶ。右上では ModelSelect と同じ見た目で、押すと右から Sheet が開く
// セットと選択はプロジェクトごとに持つ
export function ContextSetSheet() {
    const project = useAppStore(currentProject);
    const sets = useAppStore(currentContextSets);
    const selection = useAppStore(useShallow(currentContextSelection));
    const roots = useAppStore((s) => s.settings.materials.roots);
    const extensions = useAppStore((s) => s.settings.materials.extensions);
    const onChangeSelection = useAppStore((s) => s.changeContextSelection);
    const onCreate = useAppStore((s) => s.createContextSet);
    const [pickerOpen, setPickerOpen] = useState(false);
    const current = sets.find((s) => s.id === selection.setId);

    return (
        <Sheet>
            {/* 見た目は ModelSelect にそろえる（SelectTrigger と同じクラス） */}
            <div className='flex flex-col'>
                <p className='flex items-center gap-1 px-2 text-xs'>
                    <FileTextIcon className='size-3' />
                    参考資料
                </p>
                <SheetTrigger className='flex h-8 w-fit max-w-48 items-center justify-between gap-1.5 rounded-lg py-2 pr-2 pl-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50'>
                    <span className='truncate'>
                        {current ? `${contextSetName(current)}${statusLabel[current.status]}` : 'なし'}
                    </span>
                    <ChevronDownIcon className='pointer-events-none size-4 shrink-0 text-muted-foreground' />
                </SheetTrigger>
            </div>
            <SheetContent>
                <SheetHeader>
                    <SheetTitle>参考資料</SheetTitle>
                    <SheetDescription>
                        選んだ資料から用語リストとコンテキストを作り、文字起こしと要約に使います。セットはプロジェクトごとに持ちます。
                    </SheetDescription>
                </SheetHeader>
                {project ? (
                    <div className='flex flex-col gap-4 px-4'>
                        <p className='text-xs text-muted-foreground'>プロジェクト：{project.name}</p>
                        <Select
                            value={selection.setId ?? NONE}
                            onValueChange={(v) => onChangeSelection({ ...selection, setId: v === NONE ? null : v })}
                        >
                            <SelectTrigger className='w-full'>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectGroup>
                                    <SelectItem value={NONE}>使わない</SelectItem>
                                    {sets.map((set) => (
                                        <SelectItem key={set.id} value={set.id} disabled={set.status === 'failed'}>
                                            {contextSetName(set)}
                                            {statusLabel[set.status]}
                                        </SelectItem>
                                    ))}
                                </SelectGroup>
                            </SelectContent>
                        </Select>
                        {current?.status === 'generating' && (
                            <p className='text-xs text-muted-foreground'>
                                作成中です。作成中に録音を始めた場合は、できた時点から使います。
                            </p>
                        )}
                        <Button variant='outline' onClick={() => setPickerOpen(true)}>
                            <PlusIcon />
                            資料を選んで新しく作る
                        </Button>
                        <label className='flex items-center justify-between text-sm'>
                            用語リストを使う
                            <Switch
                                checked={selection.useHotwords}
                                disabled={!current}
                                onCheckedChange={(useHotwords) => onChangeSelection({ ...selection, useHotwords })}
                            />
                        </label>
                        <label className='flex items-center justify-between text-sm'>
                            コンテキストを使う
                            <Switch
                                checked={selection.useContext}
                                disabled={!current}
                                onCheckedChange={(useContext) => onChangeSelection({ ...selection, useContext })}
                            />
                        </label>
                    </div>
                ) : (
                    <p className='px-4 text-sm text-muted-foreground'>
                        参考資料はプロジェクトごとに選びます。先に左のメニューからプロジェクトを選んでください。
                    </p>
                )}
                <MaterialPickerDialog
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                    roots={roots}
                    extensions={extensions}
                    onCreate={onCreate}
                />
            </SheetContent>
        </Sheet>
    );
}
