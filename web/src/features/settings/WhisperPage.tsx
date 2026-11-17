import type { SettingsOptions } from '@/api/protocol';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { recordingLocks } from '@/features/recording/recording';
import { NumberInput } from '@/features/settings/NumberInput';
import { OptionSelect, Row, Section } from '@/features/settings/SettingsParts';
import { withCurrent } from '@/features/settings/options';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';

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
    return (
        <Section>
            <Row
                id='compute-type'
                label='計算の精度'
                locked={lock(recordingLocks.whisperModel)}
                description='int8 にすると VRAM が減りますが、精度が少し落ちます'
            >
                <OptionSelect
                    id='compute-type'
                    value={draft.whisper.computeType}
                    options={withCurrent(options.whisper.computeTypes, draft.whisper.computeType)}
                    onChange={(computeType) => update('whisper', { computeType })}
                />
            </Row>
            <Row id='beam-size' label='ビームサイズ' description='大きいほど精度が上がりますが、遅くなります'>
                <NumberInput
                    id='beam-size'
                    value={draft.whisper.beamSize}
                    min={1}
                    onChange={(beamSize) => update('whisper', { beamSize })}
                />
            </Row>
            <Row id='partial-interval' label='途中結果の間隔'>
                <NumberInput
                    id='partial-interval'
                    value={draft.whisper.partialIntervalSec}
                    min={0.1}
                    step={0.1}
                    unit='秒'
                    onChange={(partialIntervalSec) => update('whisper', { partialIntervalSec })}
                />
            </Row>
            <Row id='silence-ms' label='区切りとみなす無音' locked={lock(recordingLocks.segmentation)}>
                <NumberInput
                    id='silence-ms'
                    value={draft.whisper.silenceMs}
                    min={100}
                    step={100}
                    unit='ミリ秒'
                    onChange={(silenceMs) => update('whisper', { silenceMs })}
                />
            </Row>
            <Row id='max-segment' label='チャンクの最大の長さ' locked={lock(recordingLocks.segmentation)}>
                <NumberInput
                    id='max-segment'
                    value={draft.whisper.maxSegmentSec}
                    min={1}
                    unit='秒'
                    onChange={(maxSegmentSec) => update('whisper', { maxSegmentSec })}
                />
            </Row>
            <Row
                id='speech-threshold'
                label='話し声の判定'
                locked={lock(recordingLocks.segmentation)}
                description='自動では Silero VAD で判定し、手動では音量で判定します'
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
                            <SelectItem value='auto'>自動</SelectItem>
                            <SelectItem value='manual'>手動（音量）</SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </Row>
            {draft.whisper.speechThreshold === 'manual' && (
                <Row
                    id='speech-dbfs'
                    label='手動のときの音量'
                    locked={lock(recordingLocks.segmentation)}
                    description='この音量より大きい音を話し声とみなします（-70〜-10）'
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
            <Row
                id='final-transcript'
                label='浄書'
                description='録音終了後、文字起こしが読みやすくなるように浄書します'
            >
                <Switch
                    id='final-transcript'
                    checked={draft.whisper.finalTranscript ?? true}
                    onCheckedChange={(finalTranscript) => update('whisper', { finalTranscript })}
                />
            </Row>
            <Row
                id='diarize'
                label='話者分け'
                description='浄書済み文字起こしを「話者 1」などに分けます。HuggingFace のトークンやモデルの利用条件への同意が必要です'
            >
                <Switch
                    id='diarize'
                    checked={draft.whisper.diarize ?? true}
                    disabled={draft.whisper.finalTranscript === false}
                    onCheckedChange={(diarize) => update('whisper', { diarize })}
                />
            </Row>
            <Row id='unload-after' label='録音終了後にモデルを停止するまでの時間'>
                <NumberInput
                    id='unload-after'
                    value={draft.whisper.unloadAfterMin}
                    min={1}
                    unit='分'
                    onChange={(unloadAfterMin) => update('whisper', { unloadAfterMin })}
                />
            </Row>
        </Section>
    );
}
