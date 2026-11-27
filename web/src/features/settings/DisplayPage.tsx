import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { LanguageRow } from '@/features/settings/LanguageRow';
import { PushToggle } from '@/features/settings/PushToggle';
import { Row, Section } from '@/features/settings/SettingsParts';
import { ShortcutInput } from '@/features/settings/ShortcutInput';
import { ThemeRow } from '@/features/settings/ThemeToggle';
import { settingsMessages } from '@/features/settings/i18n';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';
import { DEFAULT_MIC_SHORTCUT } from '@/features/settings/shortcut';
import { useT } from '@/i18n/messages';

// 設定の「表示・その他」ページ
export function DisplayPage({
    draft,
    update,
    onChangeAllowedHosts,
}: {
    draft: Settings;
    update: UpdateSection;
    onChangeAllowedHosts: (allowedHosts: string[]) => void;
}) {
    const t = useT(settingsMessages);
    return (
        <>
            <Section>
                <Row id='session-meta' label={t('displayPage.sessionMeta')}>
                    <Switch
                        id='session-meta'
                        checked={draft.display.sessionMeta}
                        onCheckedChange={(sessionMeta) => update('display', { sessionMeta })}
                    />
                </Row>
                <Row id='show-picked-terms' label={t('displayPage.showPickedTerms')}>
                    <Switch
                        id='show-picked-terms'
                        checked={draft.display.showPickedTerms ?? false}
                        onCheckedChange={(showPickedTerms) => update('display', { showPickedTerms })}
                    />
                </Row>
                <Row id='show-speakers' label={t('displayPage.showSpeakers')}>
                    <Switch
                        id='show-speakers'
                        checked={draft.display.showSpeakers ?? false}
                        onCheckedChange={(showSpeakers) => update('display', { showSpeakers })}
                    />
                </Row>
                <Row id='mic-shortcut' label={t('displayPage.micShortcut')}>
                    <ShortcutInput
                        id='mic-shortcut'
                        value={draft.display.micShortcut ?? DEFAULT_MIC_SHORTCUT}
                        onChange={(micShortcut) => update('display', { micShortcut })}
                    />
                </Row>
            </Section>
            {(draft.network || draft.updates) && (
                <Section title={t('displayPage.connection')}>
                    {/* 8000 番を開ける名前（#249）。古いサーバー（network がない）では出さない */}
                    {draft.network && (
                        <Row
                            id='allowed-hosts'
                            label={t('displayPage.allowedHosts')}
                            description={t('displayPage.allowedHostsDescription')}
                        >
                            <Input
                                id='allowed-hosts'
                                className='w-56'
                                placeholder='pc.example.com'
                                value={draft.network.allowedHosts.join(', ')}
                                onChange={(e) => onChangeAllowedHosts(e.target.value.split(','))}
                            />
                        </Row>
                    )}
                    {/* アップデートの確認（#472）。古いサーバー（updates がない）では出さない */}
                    {draft.updates && (
                        <Row
                            id='update-check'
                            label={t('displayPage.updateCheck')}
                            description={t('displayPage.updateCheckDescription')}
                        >
                            <Switch
                                id='update-check'
                                checked={draft.updates.check}
                                onCheckedChange={(check) => update('updates', { check })}
                            />
                        </Row>
                    )}
                </Section>
            )}
            {/* 端末ごとの設定（テーマ・表示言語・通知。#239・#487・#245）。全体設定の保存とは別に、切り替えたときに効く */}
            <Section title={t('common.thisDevice')} description={t('common.thisDeviceDescription')}>
                <ThemeRow />
                <LanguageRow />
                <PushToggle />
            </Section>
        </>
    );
}
