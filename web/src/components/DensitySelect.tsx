import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

// 要約度（要約の細かさ。spec 3・5.3）の選択。1（ごく短く要点だけ）〜5（できるだけ省かず細かく）
const LEVELS = [
    { value: 1, label: '1 ごく短く' },
    { value: 2, label: '2 短め' },
    { value: 3, label: '3 ふつう' },
    { value: 4, label: '4 詳しく' },
    { value: 5, label: '5 できるだけ細かく' },
];

export function DensitySelect({
    id,
    value,
    onChange,
    className = 'w-44',
}: {
    id?: string;
    value: number;
    onChange: (value: number) => void;
    className?: string;
}) {
    return (
        <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
            <SelectTrigger id={id} className={className}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {LEVELS.map((l) => (
                        <SelectItem key={l.value} value={String(l.value)}>
                            {l.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
