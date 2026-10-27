import { RotateCcwIcon } from 'lucide-react';

import { OptionSelect, Row, Section } from '@/components/SettingsParts';
import { Button } from '@/components/ui/button';
import { isMissing, ollamaModelNames, thinkingNote, withCurrent } from '@/options';
import type { SettingsOptions } from '@/protocol';
import { type OllamaModels, type Settings, recommendedModels } from '@/settings';

// 選べない処理は、何を使っているかを薄い文字で出す
function Fixed({ children }: { children: React.ReactNode }) {
    return <span className='text-sm text-muted-foreground'>{children}</span>;
}

// モデルの横に出す「入っていません」（おすすめのモデルの名前は出さない。#239）
function Missing({ missing }: { missing: boolean }) {
    return missing ? <p className='text-amber-700 dark:text-amber-400'>入っていません</p> : null;
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
                    <Missing missing={isMissing(options, key, models[key])} />
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
                    処理ごとのモデルです。薄い文字のものは表示だけで、選べません
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
            <Section title='参考資料' description='Ollama で、資料から用語リストとコンテキストを作ります'>
                {ollamaRow('materialTerms', '用語リスト（資料抽出）')}
                {ollamaRow('context', 'コンテキスト', thinkingNote(options, models.context))}
                {ollamaRow('scope', '範囲の判断', '資料のどこを使うかを判断します。小さいモデルでは答えが安定しません')}
                {ollamaRow('figures', '図の読み取り', 'PDF の図を読みます。画像を読めるモデルを選んでください')}
            </Section>
            <Section title='リアルタイム文字起こし'>
                <Row id='model-vad' label='無音区間の判別'>
                    <Fixed>Silero VAD</Fixed>
                </Row>
                <Row id='whisper-model' label='文字起こし' locked={whisperLocked}>
                    <OptionSelect
                        id='whisper-model'
                        value={whisperModel}
                        options={withCurrent(options.whisper.models, whisperModel)}
                        onChange={onChangeWhisperModel}
                    />
                </Row>
                {ollamaRow('transcriptTerms', '用語リスト（文字起こし抽出）')}
            </Section>
            <Section title='浄書' description='録音終了後に、録音全体から作り直します'>
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
            <Section title='リアルタイム要約' description='録音中に数分おきに作ります（思考モードはオフ）'>
                {ollamaRow('liveSummary', '要約')}
                {ollamaRow('liveTitle', 'タイトル')}
            </Section>
            <Section title='最終要約' description='録音終了後に作ります'>
                {ollamaRow('overview', '全体概要', thinkingNote(options, models.overview))}
                {ollamaRow('detail', '要約詳細', thinkingNote(options, models.detail))}
                {ollamaRow('finalTitle', 'タイトル')}
            </Section>
        </>
    );
}
