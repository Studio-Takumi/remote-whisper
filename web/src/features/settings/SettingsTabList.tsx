import {
    CircleDotIcon,
    CpuIcon,
    FileTextIcon,
    HardDriveIcon,
    MicIcon,
    MonitorIcon,
    SparklesIcon,
    WrenchIcon,
} from 'lucide-react';

import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { settingsMessages } from '@/features/settings/i18n';
import { useT } from '@/i18n/messages';

// 設定のカテゴリ。スマホの幅では上に横並び、それ以外は左に縦並び。
export function SettingsTabList({ isMobile }: { isMobile: boolean }) {
    const t = useT(settingsMessages);
    return (
        <TabsList
            variant='line'
            className={
                // 横に並べたときは左寄せにする（中央寄せだと、はみ出したときに先頭が切れてスクロールできない）
                // スクロールは並べた向きだけにする（#239）。
                // 縦に並べたときの幅は w-40 で、それより長い名前（英語。#497）のときだけ名前に合わせて広げる
                isMobile
                    ? 'w-full shrink-0 justify-start overflow-x-auto overflow-y-hidden'
                    : 'w-max min-w-40 shrink-0 items-stretch overflow-x-hidden overflow-y-auto'
            }
        >
            {/* 並びは SETTINGS_PAGES と同じ（#239） */}
            <TabsTrigger value='models'>
                <CpuIcon />
                {t('settingsTabList.models')}
            </TabsTrigger>
            <TabsTrigger value='materials'>
                <FileTextIcon />
                {t('common.referenceMaterials')}
            </TabsTrigger>
            <TabsTrigger value='recording'>
                <CircleDotIcon />
                {t('settingsTabList.recording')}
            </TabsTrigger>
            <TabsTrigger value='whisper'>
                <MicIcon />
                {t('common.transcript')}
            </TabsTrigger>
            <TabsTrigger value='ollama'>
                <SparklesIcon />
                {t('common.summary')}
            </TabsTrigger>
            <TabsTrigger value='storage'>
                <HardDriveIcon />
                {t('settingsTabList.storage')}
            </TabsTrigger>
            <TabsTrigger value='display'>
                <MonitorIcon />
                {t('settingsTabList.display')}
            </TabsTrigger>
            <TabsTrigger value='setup'>
                <WrenchIcon />
                {t('settingsTabList.setup')}
            </TabsTrigger>
        </TabsList>
    );
}
