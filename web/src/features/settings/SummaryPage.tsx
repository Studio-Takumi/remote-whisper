import { Switch } from '@/components/ui/switch';
import { DensitySelect } from '@/features/settings/DensitySelect';
import { LlmSection } from '@/features/settings/LlmSection';
import { NumberInput } from '@/features/settings/NumberInput';
import { Row, Section } from '@/features/settings/SettingsParts';
import { SummaryLanguageSelect } from '@/features/settings/SummaryLanguageSelect';
import { settingsMessages } from '@/features/settings/i18n';
import type { LlmBackend, Settings } from '@/features/settings/settings';
import type { LmStudioSettings, UpdateSection } from '@/features/settings/settingsDraft';
import { useT } from '@/i18n/messages';

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
    const t = useT(settingsMessages);
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
                    <Row
                        id='summary-language'
                        label={t('summaryPage.language')}
                        description={t('summaryPage.languageDescription')}
                    >
                        <SummaryLanguageSelect
                            id='summary-language'
                            value={summaryLanguage}
                            onChange={(next) => update('ollama', { summaryLanguage: next })}
                        />
                    </Row>
                </Section>
            )}
            <Section
                title={t('summaryPage.summaryDetailLevel')}
                description={t('summaryPage.summaryDetailLevelDescription')}
            >
                <Row
                    id='live-density'
                    label={t('common.realTimeSummary')}
                    description={t('summaryPage.realTimeSummaryDescription')}
                >
                    <DensitySelect
                        id='live-density'
                        value={draft.ollama.liveSummaryDensity}
                        onChange={(liveSummaryDensity) => update('ollama', { liveSummaryDensity })}
                    />
                </Row>
                <Row
                    id='overview-density'
                    label={t('common.overview')}
                    description={t('summaryPage.overviewDescription')}
                >
                    <DensitySelect
                        id='overview-density'
                        value={draft.ollama.overviewDensity}
                        onChange={(overviewDensity) => update('ollama', { overviewDensity })}
                    />
                </Row>
                <Row
                    id='detail-density'
                    label={t('common.detailedSummary')}
                    description={t('summaryPage.detailedSummaryDescription')}
                >
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
                    label={t('summaryPage.materialPages')}
                    description={t('summaryPage.materialPagesDescription')}
                >
                    <Switch
                        id='detail-material-pages'
                        checked={draft.ollama.detailMaterialPages ?? false}
                        onCheckedChange={(detailMaterialPages) => update('ollama', { detailMaterialPages })}
                    />
                </Row>
                <Row id='live-interval' label={t('summaryPage.realTimeInterval')}>
                    <NumberInput
                        id='live-interval'
                        value={draft.ollama.liveSummaryIntervalMin}
                        min={1}
                        unit={t('common.minutes')}
                        onChange={(liveSummaryIntervalMin) => update('ollama', { liveSummaryIntervalMin })}
                    />
                </Row>
                <Row
                    id='pick-terms'
                    label={t('summaryPage.pickTerms')}
                    description={t('summaryPage.pickTermsDescription')}
                >
                    <Switch
                        id='pick-terms'
                        checked={draft.ollama.pickTerms ?? false}
                        onCheckedChange={(pickTerms) => update('ollama', { pickTerms })}
                    />
                </Row>
                <Row id='keep-alive' label={t('summaryPage.keepAlive')}>
                    <NumberInput
                        id='keep-alive'
                        value={draft.ollama.keepAliveMin}
                        min={1}
                        unit={t('common.minutes')}
                        onChange={(keepAliveMin) => update('ollama', { keepAliveMin })}
                    />
                </Row>
            </Section>
        </>
    );
}
