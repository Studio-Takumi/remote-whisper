import { useState } from 'react';

import type { SettingsOptions } from '@/api/protocol';
import { Button } from '@/components/ui/button';
import { DialogClose, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { recordingLocks } from '@/features/recording/recording';
import { DisplayPage } from '@/features/settings/DisplayPage';
import { MaterialsPage } from '@/features/settings/MaterialsPage';
import { ModelsPage } from '@/features/settings/ModelsPage';
import { RecordingPage } from '@/features/settings/RecordingPage';
import { SettingsTabList } from '@/features/settings/SettingsTabList';
import { SetupPage } from '@/features/settings/SetupPage';
import { StoragePage } from '@/features/settings/StoragePage';
import { SummaryPage } from '@/features/settings/SummaryPage';
import { VersionInfo } from '@/features/settings/VersionInfo';
import { WhisperPage } from '@/features/settings/WhisperPage';
import type { Settings } from '@/features/settings/settings';
import {
    type LmStudioSettings,
    type UpdateSection,
    defaultLmStudio,
    keepLocked,
} from '@/features/settings/settingsDraft';
import { useIsMobile } from '@/hooks/use-mobile';

const PAGE = 'min-h-0 overflow-x-hidden overflow-y-auto pr-2';

// 設定のモーダルの中身。開くたびに今の設定から下書きを作り、保存を押したら送る
export function SettingsForm({
    page,
    onPageChange,
    settings,
    options,
    recording,
    onSave,
}: {
    page: string;
    onPageChange: (page: string) => void;
    settings: Settings;
    options: SettingsOptions;
    recording: boolean;
    onSave: (settings: Settings) => void;
}) {
    const [edited, setDraft] = useState(settings);
    const draft = recording ? keepLocked(edited, settings) : edited;
    // 録音中に変えられない項目の理由。録音していなければ undefined（変えられる）
    const lock = (reason: string) => (recording ? reason : undefined);
    const isMobile = useIsMobile();

    const update: UpdateSection = (section, patch) => {
        setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }));
    };

    // LM Studio の設定（古いサーバーにはないので、既定値に重ねる）
    function updateLmStudio(patch: Partial<LmStudioSettings>) {
        setDraft((d) => ({ ...d, lmstudio: { ...defaultLmStudio, ...d.lmstudio, ...patch } }));
    }

    function save() {
        // 拡張子は入力途中の空要素を落とし、先頭の . をそろえてから保存する
        const extensions = draft.materials.extensions
            .map((e) => e.trim())
            .filter((e) => e !== '')
            .map((e) => (e.startsWith('.') ? e : `.${e}`));
        const roots = draft.materials.roots.map((r) => r.trim()).filter((r) => r !== '');
        // 開ける名前も、入力途中の空要素を落とす（#249）。古いサーバー（network がない）には送らない
        const network = draft.network && {
            allowedHosts: draft.network.allowedHosts.map((h) => h.trim()).filter((h) => h !== ''),
        };
        onSave({ ...draft, materials: { ...draft.materials, roots, extensions }, ...(network && { network }) });
    }

    return (
        <>
            {/* スマホの幅では、カテゴリを上に横並びにする */}
            <Tabs
                value={page}
                onValueChange={onPageChange}
                orientation={isMobile ? 'horizontal' : 'vertical'}
                className='min-h-0 flex-1 gap-4 md:gap-6'
            >
                <SettingsTabList isMobile={isMobile} />
                <TabsContent value='whisper' className={PAGE}>
                    <WhisperPage draft={draft} options={options} update={update} lock={lock} />
                </TabsContent>
                <TabsContent value='models' className={PAGE}>
                    <ModelsPage
                        draft={draft}
                        options={options}
                        whisperLocked={lock(recordingLocks.whisperModel)}
                        onChangeWhisperModel={(model) => update('whisper', { model })}
                        onChangeModels={(backend, next) =>
                            backend === 'lmstudio'
                                ? updateLmStudio({ models: next })
                                : update('ollama', { models: next })
                        }
                    />
                </TabsContent>
                <TabsContent value='ollama' className={PAGE}>
                    <SummaryPage
                        draft={draft}
                        saved={settings}
                        update={update}
                        onChangeBackend={(backend) => setDraft((d) => ({ ...d, llm: { ...d.llm, backend } }))}
                        onChangeLmStudio={updateLmStudio}
                    />
                </TabsContent>
                <TabsContent value='recording' className={PAGE}>
                    <RecordingPage draft={draft} update={update} lock={lock} />
                </TabsContent>
                <TabsContent value='storage' className={PAGE}>
                    <StoragePage draft={draft} update={update} />
                </TabsContent>
                <TabsContent value='materials' className={PAGE}>
                    <MaterialsPage draft={draft} update={update} />
                </TabsContent>
                <TabsContent value='display' className={PAGE}>
                    <DisplayPage
                        draft={draft}
                        update={update}
                        onChangeAllowedHosts={(allowedHosts) => setDraft((d) => ({ ...d, network: { allowedHosts } }))}
                    />
                </TabsContent>
                {/* 初回のセットアップの案内（#291）。全体設定の保存とは別に、ボタンを押した時点で実行する */}
                <TabsContent value='setup' className={PAGE}>
                    <SetupPage settings={settings} />
                </TabsContent>
            </Tabs>
            <DialogFooter className='sm:items-center'>
                {/* バージョンは左下に。スマホの幅（縦に逆順で並ぶ）ではボタンの下に回る */}
                <div className='order-first sm:mr-auto'>
                    <VersionInfo />
                </div>
                <DialogClose asChild>
                    <Button variant='outline'>キャンセル</Button>
                </DialogClose>
                <Button onClick={save}>保存</Button>
            </DialogFooter>
        </>
    );
}
