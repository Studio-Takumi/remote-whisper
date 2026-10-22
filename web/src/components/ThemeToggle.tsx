import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

import { Row } from '@/components/SettingsParts';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SidebarMenuButton } from '@/components/ui/sidebar';

// テーマの切り替え。押すたびに OS に合わせる → ライト → ダーク の順に変わる
const themes = [
    { value: 'system', label: 'OS に合わせる', icon: MonitorIcon },
    { value: 'light', label: 'ライト', icon: SunIcon },
    { value: 'dark', label: 'ダーク', icon: MoonIcon },
] as const;

export function ThemeToggle() {
    const { theme = 'system', setTheme } = useTheme();
    const index = Math.max(
        0,
        themes.findIndex((t) => t.value === theme),
    );
    const current = themes[index];
    const next = themes[(index + 1) % themes.length];
    const label = `テーマ: ${current.label}`;

    return (
        <SidebarMenuButton
            tooltip={`${label}（押すと「${next.label}」に切り替えます）`}
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
    const { theme = 'system', setTheme } = useTheme();
    return (
        <Row id='theme' label='テーマ'>
            <Select value={theme} onValueChange={setTheme}>
                <SelectTrigger id='theme' className='w-44'>
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    <SelectGroup>
                        {themes.map((t) => (
                            <SelectItem key={t.value} value={t.value}>
                                <t.icon />
                                {t.label}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                </SelectContent>
            </Select>
        </Row>
    );
}
