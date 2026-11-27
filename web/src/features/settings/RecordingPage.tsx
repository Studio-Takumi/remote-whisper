import { Switch } from '@/components/ui/switch';
import { recordingLocks } from '@/features/recording/recording';
import { MicDeviceRow } from '@/features/settings/MicDeviceRow';
import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';
import { useT } from '@/i18n/messages';

// 設定の「録音」ページ
export function RecordingPage({
    draft,
    update,
    lock,
}: {
    draft: Settings;
    update: UpdateSection;
    lock: (reason: string) => string | undefined;
}) {
    const t = useT(settingsMessages);
    return (
        <>
            <Section>
                <Row id='max-concurrent' label={t('recordingPage.maxConcurrent')}>
                    <NumberInput
                        id='max-concurrent'
                        value={draft.recording.maxConcurrent}
                        min={1}
                        onChange={(maxConcurrent) => update('recording', { maxConcurrent })}
                    />
                </Row>
                <Row id='resume-timeout' label={t('recordingPage.resumeTimeout')}>
                    <NumberInput
                        id='resume-timeout'
                        value={draft.recording.resumeTimeoutMin}
                        min={1}
                        unit={t('common.minutes')}
                        onChange={(resumeTimeoutMin) => update('recording', { resumeTimeoutMin })}
                    />
                </Row>
                <Row id='continue-window' label={t('recordingPage.continueWindow')}>
                    <NumberInput
                        id='continue-window'
                        value={draft.recording.continueWindowMin}
                        min={0}
                        unit={t('common.minutes')}
                        onChange={(continueWindowMin) => update('recording', { continueWindowMin })}
                    />
                </Row>
                <Row
                    id='noise-suppression'
                    label={t('recordingPage.noiseSuppression')}
                    locked={lock(recordingLocks.microphone)}
                >
                    <Switch
                        id='noise-suppression'
                        checked={draft.recording.noiseSuppression}
                        onCheckedChange={(noiseSuppression) => update('recording', { noiseSuppression })}
                    />
                </Row>
                <Row
                    id='auto-gain-control'
                    label={t('recordingPage.autoGainControl')}
                    locked={lock(recordingLocks.microphone)}
                >
                    <Switch
                        id='auto-gain-control'
                        checked={draft.recording.autoGainControl}
                        onCheckedChange={(autoGainControl) => update('recording', { autoGainControl })}
                    />
                </Row>
                <Row
                    id='echo-cancellation'
                    label={t('recordingPage.echoCancellation')}
                    locked={lock(recordingLocks.microphone)}
                >
                    <Switch
                        id='echo-cancellation'
                        checked={draft.recording.echoCancellation}
                        onCheckedChange={(echoCancellation) => update('recording', { echoCancellation })}
                    />
                </Row>
            </Section>
            {/* 端末ごとの設定（#449）。端末によってマイクが違うので、全体設定ではなくこの端末のブラウザに覚える */}
            <Section title={t('common.thisDevice')} description={t('common.thisDeviceDescription')}>
                <MicDeviceRow />
            </Section>
        </>
    );
}
