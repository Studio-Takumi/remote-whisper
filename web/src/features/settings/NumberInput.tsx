import { Input } from '@/components/ui/input';

export function NumberInput({
    id,
    value,
    min,
    max,
    step = 1,
    unit,
    onChange,
}: {
    id: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    onChange: (value: number) => void;
}) {
    return (
        <div className='flex shrink-0 items-center gap-2'>
            <Input
                id={id}
                type='number'
                className='w-24 text-right'
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(e) => onChange(e.target.valueAsNumber || 0)}
            />
            {/* 単位の欄は、単位がなくても同じ幅を取る（入力欄の右端を、単位の長さ・ありなしでずらさない。#239） */}
            <span className='w-10 shrink-0 text-xs whitespace-nowrap text-muted-foreground'>{unit}</span>
        </div>
    );
}
