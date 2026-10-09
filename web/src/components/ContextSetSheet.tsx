import { ChevronDownIcon, PlusIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';

// 参考資料セットを選ぶ。右上では ModelSelect と同じ見た目で、押すと右から Sheet が開く
export function ContextSetSheet() {
    return (
        <Sheet>
            {/* 見た目は ModelSelect にそろえる（SelectTrigger と同じクラス） */}
            <div className='flex flex-col'>
                <p className='px-2 text-xs'>参考資料</p>
                <SheetTrigger className='flex h-8 w-fit max-w-48 items-center justify-between gap-1.5 rounded-lg py-2 pr-2 pl-2.5 text-sm whitespace-nowrap outline-none focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:hover:bg-input/50'>
                    <span className='truncate'>agenda.pdf, notes.md</span>
                    <ChevronDownIcon className='pointer-events-none size-4 shrink-0 text-muted-foreground' />
                </SheetTrigger>
            </div>
            <SheetContent>
                <SheetHeader>
                    <SheetTitle>参考資料</SheetTitle>
                    <SheetDescription>
                        選んだ資料から用語リストとコンテキストを作り、文字起こしと要約に使います。
                    </SheetDescription>
                </SheetHeader>
                <div className='flex flex-col gap-4 px-4'>
                    <Select defaultValue='20261009-090501'>
                        <SelectTrigger className='w-full'>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectGroup>
                                <SelectItem value='20261009-090501'>agenda.pdf, notes.md</SelectItem>
                            </SelectGroup>
                        </SelectContent>
                    </Select>
                    <Button variant='outline'>
                        <PlusIcon />
                        資料を選んで新しく作る
                    </Button>
                    <label className='flex items-center justify-between text-sm'>
                        用語リストを使う
                        <Switch defaultChecked />
                    </label>
                    <label className='flex items-center justify-between text-sm'>
                        コンテキストを使う
                        <Switch defaultChecked />
                    </label>
                </div>
            </SheetContent>
        </Sheet>
    );
}
