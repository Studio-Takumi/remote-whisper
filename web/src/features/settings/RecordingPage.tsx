import { Switch } from '@/components/ui/switch';
import { recordingLocks } from '@/features/recording/recording';
import { MicDeviceRow } from '@/features/settings/MicDeviceRow';
import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';

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
    return (
        <>
            <Section>
                <Row id='max-concurrent' label='同時に録音できる数'>
                    <NumberInput
                        id='max-concurrent'
                        value={draft.recording.maxConcurrent}
                        min={1}
                        onChange={(maxConcurrent) => update('recording', { maxConcurrent })}
                    />
                </Row>
                <Row id='resume-timeout' label='接続が切れたときに待つ時間'>
                    <NumberInput
                        id='resume-timeout'
                        value={draft.recording.resumeTimeoutMin}
                        min={1}
                        unit='分'
                        onChange={(resumeTimeoutMin) => update('recording', { resumeTimeoutMin })}
                    />
                </Row>
                <Row id='continue-window' label='録音を終えても、続きから録音できる時間'>
                    <NumberInput
                        id='continue-window'
                        value={draft.recording.continueWindowMin}
                        min={0}
                        unit='分'
                        onChange={(continueWindowMin) => update('recording', { continueWindowMin })}
                    />
                </Row>
                <Row id='noise-suppression' label='ブラウザの雑音抑制' locked={lock(recordingLocks.microphone)}>
                    <Switch
                        id='noise-suppression'
                        checked={draft.recording.noiseSuppression}
                        onCheckedChange={(noiseSuppression) => update('recording', { noiseSuppression })}
                    />
                </Row>
                <Row id='auto-gain-control' label='ブラウザの自動音量調整' locked={lock(recordingLocks.microphone)}>
                    <Switch
                        id='auto-gain-control'
                        checked={draft.recording.autoGainControl}
                        onCheckedChange={(autoGainControl) => update('recording', { autoGainControl })}
                    />
                </Row>
                <Row id='echo-cancellation' label='ブラウザのエコー除去' locked={lock(recordingLocks.microphone)}>
                    <Switch
                        id='echo-cancellation'
                        checked={draft.recording.echoCancellation}
                        onCheckedChange={(echoCancellation) => update('recording', { echoCancellation })}
                    />
                </Row>
            </Section>
            {/* 端末ごとの設定（#449）。端末によってマイクが違うので、全体設定ではなくこの端末のブラウザに覚える */}
            <Section title='この端末' description='保存を押さなくても、切り替えた時点で効きます'>
                <MicDeviceRow />
            </Section>
        </>
    );
}
