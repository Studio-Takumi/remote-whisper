import { Switch } from '@/components/ui/switch';
import { DensitySelect } from '@/features/settings/DensitySelect';
import { LlmSection } from '@/features/settings/LlmSection';
import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import { SummaryLanguageSelect } from '@/features/settings/SummaryLanguageSelect';
import type { LlmBackend, Settings } from '@/features/settings/settings';
import type { LmStudioSettings, UpdateSection } from '@/features/settings/settingsDraft';

// 設定の「要約」ページ（URL は /settings/ollama のまま）
export function SummaryPage({
    draft,
    saved,
    update,
    onChangeBackend,
    onChangeLmStudio,
}: {
    draft: Settings;
    saved: Settings;
    update: UpdateSection;
    onChangeBackend: (backend: LlmBackend) => void;
    onChangeLmStudio: (patch: Partial<LmStudioSettings>) => void;
}) {
    const summaryLanguage = draft.ollama.summaryLanguage;
    return (
        <>
            <LlmSection
                draft={draft}
                saved={saved}
                onChangeBackend={onChangeBackend}
                onChangeOllamaHost={(host) => update('ollama', { host })}
                onChangeLmStudio={onChangeLmStudio}
            />
            {/* 古いサーバー（要約の言語を持たない）では出さない */}
            {summaryLanguage !== undefined && (
                <Section>
                    <Row id='summary-language' label='要約の言語' description='タイトルも同じ言語で付けます'>
                        <SummaryLanguageSelect
                            id='summary-language'
                            value={summaryLanguage}
                            onChange={(next) => update('ollama', { summaryLanguage: next })}
                        />
                    </Row>
                </Section>
            )}
            <Section title='要約度' description='1 は要点だけで、5 になるにつれてより細かくなります'>
                <Row id='live-density' label='リアルタイム要約' description='約 4000 文字ごとの要約'>
                    <DensitySelect
                        id='live-density'
                        value={draft.ollama.liveSummaryDensity}
                        onChange={(liveSummaryDensity) => update('ollama', { liveSummaryDensity })}
                    />
                </Row>
                <Row
                    id='overview-density'
                    label='全体概要'
                    description='長い録音で、一番上に置く「全体概要」の箇条書き'
                >
                    <DensitySelect
                        id='overview-density'
                        value={draft.ollama.overviewDensity}
                        onChange={(overviewDensity) => update('ollama', { overviewDensity })}
                    />
                </Row>
                <Row id='detail-density' label='要約詳細' description='部分ごとの要約（短い録音では要約そのもの）'>
                    <DensitySelect
                        id='detail-density'
                        value={draft.ollama.detailDensity}
                        onChange={(detailDensity) => update('ollama', { detailDensity })}
                    />
                </Row>
            </Section>
            <Section>
                <Row
                    id='detail-material-pages'
                    label='参考資料のページの表示'
                    description='要約詳細の項目に「〇〇.pdf p.12 の内容」のように資料の該当ページを表示します（PDF のみ）'
                >
                    <Switch
                        id='detail-material-pages'
                        checked={draft.ollama.detailMaterialPages ?? false}
                        onCheckedChange={(detailMaterialPages) => update('ollama', { detailMaterialPages })}
                    />
                </Row>
                <Row id='live-interval' label='リアルタイム要約の間隔'>
                    <NumberInput
                        id='live-interval'
                        value={draft.ollama.liveSummaryIntervalMin}
                        min={1}
                        unit='分'
                        onChange={(liveSummaryIntervalMin) => update('ollama', { liveSummaryIntervalMin })}
                    />
                </Row>
                <Row
                    id='pick-terms'
                    label='録音中の用語抽出'
                    description='GPU の負荷が上がります。参考資料のスイッチもオンのときだけ抽出します'
                >
                    <Switch
                        id='pick-terms'
                        checked={draft.ollama.pickTerms ?? false}
                        onCheckedChange={(pickTerms) => update('ollama', { pickTerms })}
                    />
                </Row>
                <Row id='keep-alive' label='要約後にモデルを停止するまでの時間'>
                    <NumberInput
                        id='keep-alive'
                        value={draft.ollama.keepAliveMin}
                        min={1}
                        unit='分'
                        onChange={(keepAliveMin) => update('ollama', { keepAliveMin })}
                    />
                </Row>
            </Section>
        </>
    );
}
