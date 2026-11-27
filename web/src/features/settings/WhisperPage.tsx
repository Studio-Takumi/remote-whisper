import type { SettingsOptions } from '@/api/protocol';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { recordingLocks } from '@/features/recording/recording';
import { NumberInput } from '@/features/settings/NumberInput';
import { OptionSelect, Row, Section } from '@/features/settings/SettingsParts';
import { TranscriptionLanguageSelect } from '@/features/settings/TranscriptionLanguageSelect';
import { settingsMessages } from '@/features/settings/i18n';
import { withCurrent } from '@/features/settings/options';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';
import { useT } from '@/i18n/messages';

// 設定の「文字起こし」ページ
export function WhisperPage({
    draft,
    options,
    update,
    lock,
}: {
    draft: Settings;
    options: SettingsOptions;
    update: UpdateSection;
    // 録音中に変えられない項目の理由。録音していなければ undefined（変えられる）
    lock: (reason: string) => string | undefined;
}) {
    const t = useT(settingsMessages);
    const language = draft.whisper.language;
    return (
        <Section>
            {/* 古いサーバー（言語を持たない）では出さない */}
            {language !== undefined && (
                <Row
                    id='transcription-language'
                    label={t('whisperPage.language')}
                    description={t('whisperPage.languageDescription')}
                >
                    <TranscriptionLanguageSelect
                        id='transcription-language'
                        value={language}
                        onChange={(next) => update('whisper', { language: next })}
                    />
                </Row>
            )}
            <Row
                id='compute-type'
                label={t('whisperPage.computeType')}
                locked={lock(recordingLocks.whisperModel)}
                description={t('whisperPage.computeTypeDescription')}
            >
                <OptionSelect
                    id='compute-type'
                    value={draft.whisper.computeType}
                    options={withCurrent(options.whisper.computeTypes, draft.whisper.computeType)}
                    onChange={(computeType) => update('whisper', { computeType })}
                />
            </Row>
            <Row id='beam-size' label={t('whisperPage.beamSize')} description={t('whisperPage.beamSizeDescription')}>
                <NumberInput
                    id='beam-size'
                    value={draft.whisper.beamSize}
                    min={1}
                    onChange={(beamSize) => update('whisper', { beamSize })}
                />
            </Row>
            <Row id='partial-interval' label={t('whisperPage.partialInterval')}>
                <NumberInput
                    id='partial-interval'
                    value={draft.whisper.partialIntervalSec}
                    min={0.1}
                    step={0.1}
                    unit={t('whisperPage.seconds')}
                    onChange={(partialIntervalSec) => update('whisper', { partialIntervalSec })}
                />
            </Row>
            <Row id='silence-ms' label={t('whisperPage.silence')} locked={lock(recordingLocks.segmentation)}>
                <NumberInput
                    id='silence-ms'
                    value={draft.whisper.silenceMs}
                    min={100}
                    step={100}
                    unit={t('whisperPage.milliseconds')}
                    onChange={(silenceMs) => update('whisper', { silenceMs })}
                />
            </Row>
            <Row id='max-segment' label={t('whisperPage.maxSegment')} locked={lock(recordingLocks.segmentation)}>
                <NumberInput
                    id='max-segment'
                    value={draft.whisper.maxSegmentSec}
                    min={1}
                    unit={t('whisperPage.seconds')}
                    onChange={(maxSegmentSec) => update('whisper', { maxSegmentSec })}
                />
            </Row>
            <Row
                id='speech-threshold'
                label={t('whisperPage.speechThreshold')}
                locked={lock(recordingLocks.segmentation)}
                description={t('whisperPage.speechThresholdDescription')}
            >
                <Select
                    value={draft.whisper.speechThreshold}
                    onValueChange={(v) =>
                        update('whisper', { speechThreshold: v as Settings['whisper']['speechThreshold'] })
                    }
                >
                    <SelectTrigger id='speech-threshold' className='w-44'>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem value='auto'>{t('whisperPage.speechAuto')}</SelectItem>
                            <SelectItem value='manual'>{t('whisperPage.speechManual')}</SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </Row>
            {draft.whisper.speechThreshold === 'manual' && (
                <Row
                    id='speech-dbfs'
                    label={t('whisperPage.speechDbfs')}
                    locked={lock(recordingLocks.segmentation)}
                    description={t('whisperPage.speechDbfsDescription')}
                >
                    <NumberInput
                        id='speech-dbfs'
                        value={draft.whisper.speechDbfs}
                        min={-70}
                        max={-10}
                        unit='dBFS'
                        onChange={(speechDbfs) => update('whisper', { speechDbfs })}
                    />
                </Row>
            )}
            <Row id='final-transcript' label={t('common.polish')} description={t('whisperPage.polishDescription')}>
                <Switch
                    id='final-transcript'
                    checked={draft.whisper.finalTranscript ?? true}
                    onCheckedChange={(finalTranscript) => update('whisper', { finalTranscript })}
                />
            </Row>
            <Row
                id='diarize'
                label={t('common.speakerLabeling')}
                description={t('whisperPage.speakerLabelingDescription')}
            >
                <Switch
                    id='diarize'
                    checked={draft.whisper.diarize ?? true}
                    disabled={draft.whisper.finalTranscript === false}
                    onCheckedChange={(diarize) => update('whisper', { diarize })}
                />
            </Row>
            <Row id='unload-after' label={t('whisperPage.unloadAfter')}>
                <NumberInput
                    id='unload-after'
                    value={draft.whisper.unloadAfterMin}
                    min={1}
                    unit={t('common.minutes')}
                    onChange={(unloadAfterMin) => update('whisper', { unloadAfterMin })}
                />
            </Row>
        </Section>
    );
}
