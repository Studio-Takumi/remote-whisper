import { RotateCcwIcon } from 'lucide-react';

import { OptionSelect, Row, Section } from '@/components/SettingsParts';
import { Button } from '@/components/ui/button';
import { isMissing, ollamaModelNames, thinkingNote, withCurrent } from '@/options';
import type { SettingsOptions } from '@/protocol';
import { type OllamaModels, type Settings, recommendedModels, recommendedWhisperModel } from '@/settings';

// 選べない処理は、何を使っているかを薄い文字で出す
function Fixed({ children }: { children: React.ReactNode }) {
    return <span className='text-sm text-muted-foreground'>{children}</span>;
}

// モデルの横に出す、おすすめと「入っていません」
function Hint({ recommended, missing }: { recommended: string; missing: boolean }) {
    return (
        <p className='flex flex-wrap items-center gap-x-2'>
            <span>おすすめ: {recommended}</span>
            {missing && <span className='text-amber-700 dark:text-amber-400'>入っていません</span>}
        </p>
    );
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
    onChangeModels: (models: OllamaModels) => void;
}) {
    const models = draft.ollama.models;
    const ollamaOptions = (current: string) => withCurrent(ollamaModelNames(options), current);
    const whisperModel = draft.whisper.model;

    // Ollama のモデルを選ぶ行
    const ollamaRow = (key: keyof OllamaModels, label: string, description?: string) => (
        <Row
            id={`model-${key}`}
            label={label}
            description={
                <>
                    {description && <p>{description}</p>}
                    <Hint recommended={recommendedModels[key]} missing={isMissing(options, key, models[key])} />
                </>
            }
        >
            <OptionSelect
                id={`model-${key}`}
                value={models[key]}
                options={ollamaOptions(models[key])}
                onChange={(model) => onChangeModels({ ...models, [key]: model })}
            />
        </Row>
    );

    return (
        <>
            <div className='flex items-center justify-between gap-3'>
                <p className='text-xs text-muted-foreground'>
                    処理ごとのモデルです。薄い文字のものは表示だけで、選べません。
                </p>
                <Button
                    variant='outline'
                    size='sm'
                    className='shrink-0'
                    onClick={() => onChangeModels({ ...recommendedModels })}
                >
                    <RotateCcwIcon />
                    おすすめに戻す
                </Button>
            </div>
            <Section title='参考資料' description='Ollama で、資料から用語リストとコンテキストを作る'>
                {ollamaRow('materialTerms', '用語リスト（資料抽出）')}
                {ollamaRow('context', 'コンテキスト', thinkingNote(options, models.context))}
                {ollamaRow('scope', '範囲の判断', '資料のどこを使うか。小さいモデルでは答えが安定しない')}
            </Section>
            <Section title='リアルタイム文字起こし'>
                <Row id='model-vad' label='無音区間の判別'>
                    <Fixed>Silero VAD</Fixed>
                </Row>
                <Row
                    id='whisper-model'
                    label='文字起こし'
                    locked={whisperLocked}
                    description={<Hint recommended={recommendedWhisperModel} missing={false} />}
                >
                    <OptionSelect
                        id='whisper-model'
                        value={whisperModel}
                        options={withCurrent(options.whisper.models, whisperModel)}
                        onChange={onChangeWhisperModel}
                    />
                </Row>
                {ollamaRow('transcriptTerms', '用語リスト（文字起こし抽出）')}
            </Section>
            <Section title='浄書済み文字起こし' description='録音を終えたあと、録音全体から再生成する'>
                <Row id='model-final-transcript' label='文字起こし'>
                    <Fixed>WhisperX（Whisper: {whisperModel}。リアルタイム文字起こしと同じ）</Fixed>
                </Row>
                <Row id='model-align' label='時刻合わせ'>
                    <Fixed>wav2vec2</Fixed>
                </Row>
                <Row id='model-diarize' label='話者分け'>
                    <Fixed>WhisperX（pyannote）</Fixed>
                </Row>
            </Section>
            <Section title='リアルタイム要約' description='録音中に数分おきに作る。思考モードはオフ'>
                {ollamaRow('liveSummary', '要約')}
                {ollamaRow('liveTitle', 'タイトル')}
            </Section>
            <Section title='最終要約' description='録音が終わった後に作る'>
                {ollamaRow('overview', '全体概要', thinkingNote(options, models.overview))}
                {ollamaRow('detail', '要約詳細', thinkingNote(options, models.detail))}
                {ollamaRow('finalTitle', 'タイトル')}
            </Section>
        </>
    );
}
