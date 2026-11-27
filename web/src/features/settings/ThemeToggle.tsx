import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidebarMenuButton } from '@/components/ui/sidebar';
import { Row } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import { useT } from '@/i18n/messages';

// テーマの切り替え。押すたびに OS に合わせる → ライト → ダーク の順に変わる
const themes = [
    { value: 'system', labelKey: 'themeToggle.system', icon: MonitorIcon },
    { value: 'light', labelKey: 'themeToggle.light', icon: SunIcon },
    { value: 'dark', labelKey: 'themeToggle.dark', icon: MoonIcon },
] as const;

export function ThemeToggle() {
    const t = useT(settingsMessages);
    const { theme = 'system', setTheme } = useTheme();
    const index = Math.max(
        0,
        themes.findIndex((th) => th.value === theme),
    );
    const current = themes[index];
    const next = themes[(index + 1) % themes.length];
    const label = t('themeToggle.current', { name: t(current.labelKey) });

    return (
        <SidebarMenuButton
            tooltip={t('themeToggle.tooltip', { label, next: t(next.labelKey) })}
            aria-label={label}
            onClick={() => setTheme(next.value)}
        >
            <current.icon />
            <span>{label}</span>
        </SidebarMenuButton>
    );
}

// 設定モーダル（表示・その他）のテーマの項目（#239）。サイドバーのボタンと同じく、端末ごと（localStorage）
export function ThemeRow() {
    const t = useT(settingsMessages);
    const { theme = 'system', setTheme } = useTheme();
    return (
        <Row id='theme' label={t('themeToggle.theme')}>
            <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger id='theme' className='w-44'>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        {themes.map((th) => (
                            <SelectItem key={th.value} value={th.value}>
                                <th.icon />
                                {t(th.labelKey)}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Row>
    );
}
