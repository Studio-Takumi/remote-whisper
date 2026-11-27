import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { settingsMessages } from '@/features/settings/i18n';
import { type TranscriptionLanguage, transcriptionLanguages } from '@/features/settings/settings';
import { useT } from '@/i18n/messages';

// 文字起こしの言語（#482）を選ぶ。設定の「文字起こし」ページと新規セッション画面で使う
export function TranscriptionLanguageSelect({
    id,
    value,
    onChange,
    size = 'default',
}: {
    id: string;
    value: TranscriptionLanguage;
    onChange: (value: TranscriptionLanguage) => void;
    size?: 'default' | 'sm';
}) {
    const t = useT(settingsMessages);
    return (
        <Select value={value} onValueChange={(v) => onChange(v as TranscriptionLanguage)}>
            <SelectTrigger id={id} size={size} className={size === 'sm' ? 'w-32' : 'w-44'}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                <SelectGroup>
                    {transcriptionLanguages.map((l) => (
                        <SelectItem key={l.value} value={l.value}>
                            {'labelKey' in l ? t(l.labelKey) : l.label}
                        </SelectItem>
                    ))}
                </SelectGroup>
            </SelectContent>
        </Select>
    );
}
