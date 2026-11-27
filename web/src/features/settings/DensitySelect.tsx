import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { settingsMessages } from '@/features/settings/i18n';
import { useT } from '@/i18n/messages';

// 要約度（要約の細かさ。spec/README.md 3・spec/files.md 5.3）の選択。1（ごく短く要点だけ）〜5（できるだけ省かず細かく）
const LEVELS: { value: number; labelKey: `densitySelect.level${1 | 2 | 3 | 4 | 5}` }[] = [
    { value: 1, labelKey: 'densitySelect.level1' },
    { value: 2, labelKey: 'densitySelect.level2' },
    { value: 3, labelKey: 'densitySelect.level3' },
    { value: 4, labelKey: 'densitySelect.level4' },
    { value: 5, labelKey: 'densitySelect.level5' },
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
    const t = useT(settingsMessages);
    return (
        <Select value={String(value)} onValueChange={(v) => onChange(Number(v))}>
            <SelectTrigger id={id} className={className}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {LEVELS.map((l) => (
                        <SelectItem key={l.value} value={String(l.value)}>
                            {t(l.labelKey)}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
