import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';
import { useT } from '@/i18n/messages';

// 設定の「保存」ページ（保存期間）
export function StoragePage({ draft, update }: { draft: Settings; update: UpdateSection }) {
    const t = useT(settingsMessages);
    return (
        <Section title={t('storagePage.retention')} description={t('storagePage.retentionDescription')}>
            <Row id='keep-recording' label={t('storagePage.recordingFile')}>
                <NumberInput
                    id='keep-recording'
                    value={draft.retentionDays.recording}
                    min={0}
                    unit={t('storagePage.days')}
                    onChange={(recording) => update('retentionDays', { recording })}
                />
            </Row>
            <Row id='keep-transcript' label={t('common.transcript')}>
                <NumberInput
                    id='keep-transcript'
                    value={draft.retentionDays.transcript}
                    min={0}
                    unit={t('storagePage.days')}
                    onChange={(transcript) => update('retentionDays', { transcript })}
                />
            </Row>
            <Row id='keep-summary' label={t('common.summary')} description={t('storagePage.summaryDescription')}>
                <NumberInput
                    id='keep-summary'
                    value={draft.retentionDays.summary}
                    min={0}
                    unit={t('storagePage.days')}
                    onChange={(summary) => update('retentionDays', { summary })}
                />
            </Row>
            <Row id='keep-context' label={t('common.referenceMaterials')}>
                <NumberInput
                    id='keep-context'
                    value={draft.retentionDays.contextSet}
                    min={0}
                    unit={t('storagePage.days')}
                    onChange={(contextSet) => update('retentionDays', { contextSet })}
                />
            </Row>
        </Section>
    );
}
