import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';

// 設定の「保存」ページ（保存期間）
export function StoragePage({ draft, update }: { draft: Settings; update: UpdateSection }) {
    return (
        <Section title='保存期間' description='期間を過ぎたファイルは自動で消えます。0 にすると無期限です'>
            <Row id='keep-recording' label='録音ファイル'>
                <NumberInput
                    id='keep-recording'
                    value={draft.retentionDays.recording}
                    min={0}
                    unit='日'
                    onChange={(recording) => update('retentionDays', { recording })}
                />
            </Row>
            <Row id='keep-transcript' label='文字起こし'>
                <NumberInput
                    id='keep-transcript'
                    value={draft.retentionDays.transcript}
                    min={0}
                    unit='日'
                    onChange={(transcript) => update('retentionDays', { transcript })}
                />
            </Row>
            <Row id='keep-summary' label='要約' description='選んだディレクトリに置いたコピーは消しません'>
                <NumberInput
                    id='keep-summary'
                    value={draft.retentionDays.summary}
                    min={0}
                    unit='日'
                    onChange={(summary) => update('retentionDays', { summary })}
                />
            </Row>
            <Row id='keep-context' label='参考資料'>
                <NumberInput
                    id='keep-context'
                    value={draft.retentionDays.contextSet}
                    min={0}
                    unit='日'
                    onChange={(contextSet) => update('retentionDays', { contextSet })}
                />
            </Row>
        </Section>
    );
}
