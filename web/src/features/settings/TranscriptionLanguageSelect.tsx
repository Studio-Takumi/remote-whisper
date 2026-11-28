import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { settingsMessages } from '@/features/settings/i18n';
import { type TranscriptionLanguage, transcriptionLanguages } from '@/features/settings/settings';
import { useT } from '@/i18n/messages';
import { cn } from '@/lib/utils';

// 文字起こしの言語（#482）を選ぶ。設定の「文字起こし」ページと新規セッション画面で使う。
// value が null（未設定。#498）なら何も選ばず、fallback（表示言語から決めた値）の名前を選んだときと同じ見た目で出す。
// どちらを選んでも onChange が呼ばれる（出ている値と同じものを選んでも保存できるように）
export function TranscriptionLanguageSelect({
    id,
    value,
    fallback,
    onChange,
    size = 'default',
}: {
    id: string;
    value: TranscriptionLanguage | null;
    fallback?: TranscriptionLanguage;
    onChange: (value: TranscriptionLanguage) => void;
    size?: 'default' | 'sm';
}) {
    const t = useT(settingsMessages);
    const label = (v: TranscriptionLanguage | undefined) => {
        const option = transcriptionLanguages.find((l) => l.value === v);
        // 言語の名前（日本語）は、どの表示言語でもその言語の字形で出す（#497）
        return option && ('labelKey' in option ? t(option.labelKey) : <span lang={option.value}>{option.label}</span>);
    };
    return (
        <Select value={value ?? ''} onValueChange={(v) => onChange(v as TranscriptionLanguage)}>
            <SelectTrigger
                id={id}
                size={size}
                className={cn(size === 'sm' ? 'w-32' : 'w-44', 'data-placeholder:text-foreground')}
            >
                <SelectValue placeholder={label(fallback)} />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {transcriptionLanguages.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                            {label(l.value)}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
