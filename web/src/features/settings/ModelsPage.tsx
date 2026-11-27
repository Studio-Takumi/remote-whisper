import { RotateCcwIcon } from 'lucide-react';

import type { SettingsOptions } from '@/api/protocol';
import { Button } from '@/components/ui/button';
import { OptionSelect, Row, Section } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import { isMissing, llmModelNames, thinkingNote, withCurrent } from '@/features/settings/options';
import {
    LLM_NAMES,
    type LlmBackend,
    type OllamaModels,
    type Settings,
    llmBackend,
    llmModels,
    recommendedModelsFor,
} from '@/features/settings/settings';
import { useT } from '@/i18n/messages';

// 選べない処理は、何を使っているかを薄い文字で出す
function Fixed({ children }: { children: React.ReactNode }) {
    return <span className='text-sm text-muted-foreground'>{children}</span>;
}

// モデルの横に出す「入っていません」（おすすめのモデルの名前は出さない。#239）
function Missing({ missing }: { missing: boolean }) {
    const t = useT(settingsMessages);
    return missing ? <p className='text-amber-700 dark:text-amber-400'>{t('modelsPage.notInstalled')}</p> : null;
}

// 設定モーダルの「モデル」ページ（#179）。どの処理でどのモデルを使うかを、大きな段階ごとに並べる
export function ModelsPage({
    draft,
    options,
    whisperLocked,
    onChangeWhisperModel,
    onChangeModels,
}: {
    draft: Settings;
    options: SettingsOptions;
    // 録音中にロックされている理由（Whisper のモデル）。録音していなければ undefined
    whisperLocked?: string;
    onChangeWhisperModel: (model: string) => void;
    // 選んでいる LLM（llm.backend）の処理ごとのモデルを変える（ollama.models か lmstudio.models。#327）
    onChangeModels: (backend: LlmBackend, models: OllamaModels) => void;
}) {
    const t = useT(settingsMessages);
    // 選んでいる LLM（設定モーダルで切り替えたら、保存する前でもそちら）
    const backend = llmBackend(draft);
    const models = llmModels(draft);
    // 一覧は、サーバーが今使っている LLM のもの。保存する前に切り替えたとき（と、録音中に切り替えて
    // 録音が終わるのを待っているとき）は、まだ選べる一覧がない
    const listed = options.llm.backend === backend;
    const ollamaOptions = (current: string) => withCurrent(llmModelNames(options, backend), current);
    const whisperModel = draft.whisper.model;

    // LLM（Ollama か LM Studio）のモデルを選ぶ行
    const ollamaRow = (key: keyof OllamaModels, label: string, description?: string) => (
        <Row
            id={`model-${key}`}
            label={label}
            description={
                <>
                    {description && <p>{description}</p>}
                    <Missing missing={isMissing(options, backend, key, models[key])} />
                </>
            }
        >
            <OptionSelect
                id={`model-${key}`}
                value={models[key]}
                options={ollamaOptions(models[key])}
                onChange={(model) => onChangeModels(backend, { ...models, [key]: model })}
                // LM Studio の ID（google/gemma-4-e4b など）は長いので広げる
                className='w-56'
            />
        </Row>
    );

    return (
        <>
            <div className='flex items-center justify-between gap-3'>
                <p className='text-xs text-muted-foreground'>{t('modelsPage.intro', { llm: LLM_NAMES[backend] })}</p>
                <Button
                    variant='outline'
                    size='sm'
                    className='shrink-0'
                    onClick={() => onChangeModels(backend, { ...recommendedModelsFor(backend) })}
                >
                    <RotateCcwIcon />
                    {t('modelsPage.restoreRecommended')}
                </Button>
            </div>
            {!listed && (
                <p className='mt-2 text-xs text-amber-700 dark:text-amber-400'>
                    {t('modelsPage.switching', { llm: LLM_NAMES[backend] })}
                </p>
            )}
            <Section
                title={t('common.referenceMaterials')}
                description={t('modelsPage.referenceMaterialsDescription', { llm: LLM_NAMES[backend] })}
            >
                {ollamaRow('materialTerms', t('modelsPage.termListFromMaterials'))}
                {ollamaRow('context', t('modelsPage.context'), thinkingNote(options, models.context))}
                {ollamaRow('scope', t('modelsPage.scope'), t('modelsPage.scopeDescription'))}
                {ollamaRow('figures', t('common.figureReading'), t('modelsPage.figuresDescription'))}
            </Section>
            <Section title={t('modelsPage.realTimeTranscript')}>
                <Row id='model-vad' label={t('modelsPage.vad')}>
                    <Fixed>Silero VAD</Fixed>
                </Row>
                <Row id='whisper-model' label={t('common.transcript')} locked={whisperLocked}>
                    <OptionSelect
                        id='whisper-model'
                        value={whisperModel}
                        options={withCurrent(options.whisper.models, whisperModel)}
                        onChange={onChangeWhisperModel}
                    />
                </Row>
                {ollamaRow('transcriptTerms', t('modelsPage.termListFromTranscript'))}
            </Section>
            <Section title={t('common.polish')} description={t('modelsPage.polishDescription')}>
                <Row id='model-final-transcript' label={t('common.transcript')}>
                    <Fixed>{t('modelsPage.polishTranscript', { model: whisperModel })}</Fixed>
                </Row>
                <Row id='model-align' label={t('modelsPage.align')}>
                    <Fixed>wav2vec2</Fixed>
                </Row>
                <Row id='model-diarize' label={t('common.speakerLabeling')}>
                    <Fixed>WhisperX（pyannote）</Fixed>
                </Row>
            </Section>
            <Section title={t('common.realTimeSummary')} description={t('modelsPage.realTimeSummaryDescription')}>
                {ollamaRow('liveSummary', t('common.summary'))}
                {ollamaRow('liveTitle', t('modelsPage.title'))}
            </Section>
            <Section title={t('modelsPage.finalSummary')} description={t('modelsPage.finalSummaryDescription')}>
                {ollamaRow('overview', t('common.overview'), thinkingNote(options, models.overview))}
                {ollamaRow('detail', t('common.detailedSummary'), thinkingNote(options, models.detail))}
                {ollamaRow('finalTitle', t('modelsPage.title'))}
            </Section>
        </>
    );
}
