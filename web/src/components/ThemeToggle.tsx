import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useTheme } from 'next-themes';

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
