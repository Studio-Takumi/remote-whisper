import { ChevronDownIcon, GaugeIcon } from 'lucide-react';

import { DensitySelect } from '@/components/DensitySelect';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { Settings } from '@/settings';

type DensityKey = 'liveSummaryDensity' | 'overviewDensity' | 'detailDensity';

const ROWS: { key: DensityKey; label: string }[] = [
    { key: 'liveSummaryDensity', label: '途中の要約' },
    { key: 'overviewDensity', label: '最終の要約の概要' },
    { key: 'detailDensity', label: '最終の要約の詳細' },
];

// 簡易設定の要約度（spec 8）。上のバーには「途中・概要・詳細」の3つの値を並べて出し、押すと選べる
export function DensityQuickSetting({
    settings,
    onChange,
}: {
    settings: Settings;
    onChange: (settings: Settings) => void;
}) {
    const ollama = settings.ollama;
    return (
        <div className='flex flex-col'>
            <p className='flex items-center gap-1 px-2 text-xs'>
                <GaugeIcon className='size-3' />
                要約度
            </p>
            <Popover>
                <PopoverTrigger asChild>
                    <button
                        className='flex h-9 items-center gap-1.5 rounded-md px-3 text-sm tabular-nums hover:bg-muted'
                        aria-label='要約度（途中の要約・最終の要約の概要・最終の要約の詳細）'
                    >
                        {ROWS.map((r) => ollama[r.key]).join('・')}
                        <ChevronDownIcon className='size-4 opacity-50' />
                    </button>
                </PopoverTrigger>
                <PopoverContent align='end' className='flex w-72 flex-col gap-3'>
                    <p className='text-xs text-muted-foreground'>
                        要約の細かさ。1 はごく短く要点だけ、5 はできるだけ省かず細かく
                    </p>
                    {ROWS.map((r) => (
                        <div key={r.key} className='flex items-center justify-between gap-2'>
                            <Label htmlFor={`quick-${r.key}`} className='text-sm'>
                                {r.label}
                            </Label>
                            <DensitySelect
                                id={`quick-${r.key}`}
                                className='w-40'
                                value={ollama[r.key]}
                                onChange={(value) => onChange({ ...settings, ollama: { ...ollama, [r.key]: value } })}
                            />
                        </div>
                    ))}
                </PopoverContent>
            </Popover>
        </div>
    );
}
