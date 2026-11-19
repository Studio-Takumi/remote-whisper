import {
    CircleDotIcon,
    CpuIcon,
    FileTextIcon,
    HardDriveIcon,
    MicIcon,
    MonitorIcon,
    SmartphoneIcon,
    SparklesIcon,
    WrenchIcon,
} from 'lucide-react';

import { TabsList, TabsTrigger } from '@/components/ui/tabs';
import { NATIVE_SETTINGS_PAGE } from '@/features/native/nativePlatform';

// 設定のカテゴリ。スマホの幅では上に横並び、それ以外は左に縦並び。
// native は iOS アプリの中で開いているとき（#438）。そのときだけ最後に「iOS アプリ」を足す
export function SettingsTabList({ isMobile, native }: { isMobile: boolean; native: boolean }) {
    return (
        <TabsList
            variant='line'
            className={
                // 横に並べたときは左寄せにする（中央寄せだと、はみ出したときに先頭が切れてスクロールできない）
                // スクロールは並べた向きだけにする（#239）
                isMobile
                    ? 'w-full shrink-0 justify-start overflow-x-auto overflow-y-hidden'
                    : 'w-40 shrink-0 items-stretch overflow-x-hidden overflow-y-auto'
            }
        >
            {/* 並びは SETTINGS_PAGES と同じ（#239） */}
            <TabsTrigger value='models'>
                <CpuIcon />
                モデル
            </TabsTrigger>
            <TabsTrigger value='materials'>
                <FileTextIcon />
                参考資料
            </TabsTrigger>
            <TabsTrigger value='recording'>
                <CircleDotIcon />
                録音
            </TabsTrigger>
            <TabsTrigger value='whisper'>
                <MicIcon />
                文字起こし
            </TabsTrigger>
            <TabsTrigger value='ollama'>
                <SparklesIcon />
                要約
            </TabsTrigger>
            <TabsTrigger value='storage'>
                <HardDriveIcon />
                保存
            </TabsTrigger>
            <TabsTrigger value='display'>
                <MonitorIcon />
                表示・その他
            </TabsTrigger>
            <TabsTrigger value='setup'>
                <WrenchIcon />
                セットアップ
            </TabsTrigger>
            {native && (
                <TabsTrigger value={NATIVE_SETTINGS_PAGE}>
                    <SmartphoneIcon />
                    iOS アプリ
                </TabsTrigger>
            )}
        </TabsList>
    );
}
