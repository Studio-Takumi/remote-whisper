import { useState } from 'react';

import {
    CircleDotIcon,
    CpuIcon,
    FileTextIcon,
    FolderIcon,
    HardDriveIcon,
    MicIcon,
    MonitorIcon,
    PlusIcon,
    SparklesIcon,
    Trash2Icon,
} from 'lucide-react';

import { DensitySelect } from '@/components/DensitySelect';
import { ModelsPage } from '@/components/ModelsPage';
import { PushToggle } from '@/components/PushToggle';
import { OptionSelect, Row, Section } from '@/components/SettingsParts';
import { ShortcutInput } from '@/components/ShortcutInput';
import { VersionInfo } from '@/components/VersionInfo';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { withCurrent } from '@/options';
import type { SettingsOptions } from '@/protocol';
import { recordingLocks } from '@/recording';
import { SETTINGS_PAGES, type Settings } from '@/settings';
import { DEFAULT_MIC_SHORTCUT } from '@/shortcut';

// 全体設定のモーダル。左にカテゴリ、右に項目を並べる
export function SettingsDialog({
    open,
    onOpenChange,
    page,
    onPageChange,
    settings,
    options,
    recording,
    onSave,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // 開いているページ（URL の /settings/<ページ>。#177）。知らないページなら最初のページ
    page: string;
    onPageChange: (page: string) => void;
    settings: Settings;
    options: SettingsOptions;
    recording: boolean;
    onSave: (settings: Settings) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className='flex h-[min(640px,85vh)] flex-col sm:max-w-3xl'
                onEscapeKeyDown={(e) => {
                    // ショートカットのキーを決めている間の Esc は、決めるのをやめるだけにする（ShortcutInput）
                    if (
                        document.activeElement instanceof HTMLElement &&
                        document.activeElement.dataset.shortcutCapture
                    ) {
                        e.preventDefault();
                    }
                }}
            >
                <DialogHeader>
                    <DialogTitle>設定</DialogTitle>
                    <DialogDescription>
                        {recording ? '全体設定（録音中は一部の項目は変更不可）' : '全体設定（どの端末でも共通）'}
                    </DialogDescription>
                </DialogHeader>
                {/* DialogContent は閉じると消えるので、開くたびに今の設定から下書きを作り直せる */}
                <SettingsForm
                    page={SETTINGS_PAGES.includes(page) ? page : SETTINGS_PAGES[0]}
                    onPageChange={onPageChange}
                    settings={settings}
                    options={options}
                    recording={recording}
                    onSave={(s) => {
                        onSave(s);
                        onOpenChange(false);
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

// 録音中に変えられない項目（#133・spec/files.md 5.3）は、今の設定の値に戻す。
// 開いている間に録音が始まっても、変えた値を送って断られないように
function keepLocked(draft: Settings, current: Settings): Settings {
    const { model, computeType, silenceMs, maxSegmentSec, speechThreshold, speechDbfs } = current.whisper;
    const { noiseSuppression, autoGainControl, echoCancellation } = current.recording;
    return {
        ...draft,
        whisper: { ...draft.whisper, model, computeType, silenceMs, maxSegmentSec, speechThreshold, speechDbfs },
        recording: { ...draft.recording, noiseSuppression, autoGainControl, echoCancellation },
    };
}

function SettingsForm({
    page,
    onPageChange,
    settings,
    options,
    recording,
    onSave,
}: {
    page: string;
    onPageChange: (page: string) => void;
    settings: Settings;
    options: SettingsOptions;
    recording: boolean;
    onSave: (settings: Settings) => void;
}) {
    const [edited, setDraft] = useState(settings);
    const draft = recording ? keepLocked(edited, settings) : edited;
    // 録音中に変えられない項目の理由。録音していなければ undefined（変えられる）
    const lock = (reason: string) => (recording ? reason : undefined);
    const isMobile = useIsMobile();

    function update<K extends Exclude<keyof Settings, 'version'>>(section: K, patch: Partial<Settings[K]>) {
        setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }));
    }

    function save() {
        // 拡張子は入力途中の空要素を落とし、先頭の . をそろえてから保存する
        const extensions = draft.materials.extensions
            .map((e) => e.trim())
            .filter((e) => e !== '')
            .map((e) => (e.startsWith('.') ? e : `.${e}`));
        const roots = draft.materials.roots.map((r) => r.trim()).filter((r) => r !== '');
        onSave({ ...draft, materials: { roots, extensions } });
    }

    return (
        <>
            {/* スマホの幅では、カテゴリを上に横並びにする */}
            <Tabs
                value={page}
                onValueChange={onPageChange}
                orientation={isMobile ? 'horizontal' : 'vertical'}
                className='min-h-0 flex-1 gap-4 md:gap-6'
            >
                <TabsList
                    variant='line'
                    className={
                        // 横に並べたときは左寄せにする（中央寄せだと、はみ出したときに先頭が切れてスクロールできない）
                        isMobile ? 'w-full shrink-0 justify-start overflow-x-auto' : 'w-40 shrink-0 items-stretch'
                    }
                >
                    <TabsTrigger value='whisper'>
                        <MicIcon />
                        文字起こし
                    </TabsTrigger>
                    <TabsTrigger value='models'>
                        <CpuIcon />
                        モデル
                    </TabsTrigger>
                    <TabsTrigger value='ollama'>
                        <SparklesIcon />
                        要約
                    </TabsTrigger>
                    <TabsTrigger value='recording'>
                        <CircleDotIcon />
                        録音
                    </TabsTrigger>
                    <TabsTrigger value='storage'>
                        <HardDriveIcon />
                        保存
                    </TabsTrigger>
                    <TabsTrigger value='materials'>
                        <FileTextIcon />
                        参考資料
                    </TabsTrigger>
                    <TabsTrigger value='display'>
                        <MonitorIcon />
                        表示
                    </TabsTrigger>
                </TabsList>

                <TabsContent value='whisper' className='min-h-0 overflow-y-auto pr-2'>
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
                        <Row
                            id='beam-size'
                            label='ビームサイズ'
                            description='大きいほど精度が上がりますが、遅くなります'
                        >
                            <NumberInput
                                id='beam-size'
                                value={draft.whisper.beamSize}
                                min={1}
                                onChange={(beamSize) => update('whisper', { beamSize })}
                            />
                        </Row>
                        <Row
                            id='partial-interval'
                            label='途中結果の間隔'
                            description='話している間、この間隔で文字起こしを更新します'
                        >
                            <NumberInput
                                id='partial-interval'
                                value={draft.whisper.partialIntervalSec}
                                min={0.1}
                                step={0.1}
                                unit='秒'
                                onChange={(partialIntervalSec) => update('whisper', { partialIntervalSec })}
                            />
                        </Row>
                        <Row
                            id='silence-ms'
                            label='区切りとみなす無音'
                            locked={lock(recordingLocks.segmentation)}
                            description='この長さだけ無音が続いたら、チャンクを確定します'
                        >
                            <NumberInput
                                id='silence-ms'
                                value={draft.whisper.silenceMs}
                                min={100}
                                step={100}
                                unit='ミリ秒'
                                onChange={(silenceMs) => update('whisper', { silenceMs })}
                            />
                        </Row>
                        <Row
                            id='max-segment'
                            label='チャンクの最大の長さ'
                            locked={lock(recordingLocks.segmentation)}
                            description='無音がなくても、この長さでチャンクを確定します'
                        >
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
                                description='この音量より大きい音を話し声とみなします（-70〜-10）。小さくすると雑音も拾います'
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
                        <Row
                            id='unload-after'
                            label='録音終了後にモデルを停止するまでの時間'
                            description='過ぎたらモデルを止めて、VRAM を空けます'
                        >
                            <NumberInput
                                id='unload-after'
                                value={draft.whisper.unloadAfterMin}
                                min={1}
                                unit='分'
                                onChange={(unloadAfterMin) => update('whisper', { unloadAfterMin })}
                            />
                        </Row>
                    </Section>
                </TabsContent>

                <TabsContent value='models' className='min-h-0 overflow-y-auto pr-2'>
                    <ModelsPage
                        draft={draft}
                        options={options}
                        whisperLocked={lock(recordingLocks.whisperModel)}
                        onChangeWhisperModel={(model) => update('whisper', { model })}
                        onChangeModels={(next) => update('ollama', { models: next })}
                    />
                </TabsContent>

                <TabsContent value='ollama' className='min-h-0 overflow-y-auto pr-2'>
                    <Section>
                        <Row id='ollama-host' label='Ollama の URL'>
                            <Input
                                id='ollama-host'
                                className='w-56'
                                value={draft.ollama.host}
                                onChange={(e) => update('ollama', { host: e.target.value })}
                            />
                        </Row>
                    </Section>
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
                        <Row
                            id='detail-density'
                            label='要約詳細'
                            description='部分ごとの要約（短い録音では要約そのもの）'
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
                            description='何度も出てくる固有名詞・専門用語を、リアルタイム要約と同じ間隔で用語リストに足します。GPU の負荷が上がります。参考資料のスイッチもオンのときだけ抽出します'
                        >
                            <Switch
                                id='pick-terms'
                                checked={draft.ollama.pickTerms ?? false}
                                onCheckedChange={(pickTerms) => update('ollama', { pickTerms })}
                            />
                        </Row>
                        <Row
                            id='keep-alive'
                            label='要約後にモデルを停止するまでの時間'
                            description='過ぎたらモデルを止めて、VRAM を空けます（録音中は止めません）'
                        >
                            <NumberInput
                                id='keep-alive'
                                value={draft.ollama.keepAliveMin}
                                min={1}
                                unit='分'
                                onChange={(keepAliveMin) => update('ollama', { keepAliveMin })}
                            />
                        </Row>
                    </Section>
                </TabsContent>

                <TabsContent value='recording' className='min-h-0 overflow-y-auto pr-2'>
                    <Section>
                        <Row id='max-concurrent' label='同時に録音できる数'>
                            <NumberInput
                                id='max-concurrent'
                                value={draft.recording.maxConcurrent}
                                min={1}
                                onChange={(maxConcurrent) => update('recording', { maxConcurrent })}
                            />
                        </Row>
                        <Row
                            id='resume-timeout'
                            label='接続が切れたときに待つ時間'
                            description='この時間内に接続し直せば、録音が続きます'
                        >
                            <NumberInput
                                id='resume-timeout'
                                value={draft.recording.resumeTimeoutMin}
                                min={1}
                                unit='分'
                                onChange={(resumeTimeoutMin) => update('recording', { resumeTimeoutMin })}
                            />
                        </Row>
                        <Row
                            id='continue-window'
                            label='録音を終えても、続きから録音できる時間'
                            description='マイクボタンで同じセッションの続きを録音できます。0 なら続けられません'
                        >
                            <NumberInput
                                id='continue-window'
                                value={draft.recording.continueWindowMin}
                                min={0}
                                unit='分'
                                onChange={(continueWindowMin) => update('recording', { continueWindowMin })}
                            />
                        </Row>
                        <Row
                            id='noise-suppression'
                            label='ブラウザの雑音抑制'
                            locked={lock(recordingLocks.microphone)}
                            description='ブラウザがマイクの雑音を抑えます'
                        >
                            <Switch
                                id='noise-suppression'
                                checked={draft.recording.noiseSuppression}
                                onCheckedChange={(noiseSuppression) => update('recording', { noiseSuppression })}
                            />
                        </Row>
                        <Row
                            id='auto-gain-control'
                            label='ブラウザの自動音量調整'
                            locked={lock(recordingLocks.microphone)}
                            description='ブラウザがマイクの音量を自動で上げ下げします'
                        >
                            <Switch
                                id='auto-gain-control'
                                checked={draft.recording.autoGainControl}
                                onCheckedChange={(autoGainControl) => update('recording', { autoGainControl })}
                            />
                        </Row>
                        <Row
                            id='echo-cancellation'
                            label='ブラウザのエコー除去'
                            locked={lock(recordingLocks.microphone)}
                            description='スピーカーの音がマイクに回り込むのを消します。文字起こしが止まるときは切ってみてください'
                        >
                            <Switch
                                id='echo-cancellation'
                                checked={draft.recording.echoCancellation}
                                onCheckedChange={(echoCancellation) => update('recording', { echoCancellation })}
                            />
                        </Row>
                    </Section>
                </TabsContent>

                <TabsContent value='storage' className='min-h-0 overflow-y-auto pr-2'>
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
                </TabsContent>

                <TabsContent value='materials' className='min-h-0 overflow-y-auto pr-2'>
                    <Section
                        title='読み込めるフォルダ'
                        description='参考資料とプロジェクトは、このフォルダの中から選びます'
                    >
                        <div className='flex flex-col gap-2'>
                            {draft.materials.roots.map((root, i) => (
                                <div key={i} className='flex items-center gap-2'>
                                    <FolderIcon className='size-4 shrink-0 text-muted-foreground' />
                                    <Input
                                        value={root}
                                        placeholder='D:\work'
                                        aria-label={`フォルダ ${i + 1}`}
                                        onChange={(e) =>
                                            update('materials', {
                                                roots: draft.materials.roots.map((r, j) =>
                                                    j === i ? e.target.value : r,
                                                ),
                                            })
                                        }
                                    />
                                    <Button
                                        variant='ghost'
                                        size='icon-sm'
                                        aria-label='このフォルダを外す'
                                        onClick={() =>
                                            update('materials', {
                                                roots: draft.materials.roots.filter((_, j) => j !== i),
                                            })
                                        }
                                    >
                                        <Trash2Icon />
                                    </Button>
                                </div>
                            ))}
                            <Button
                                variant='outline'
                                size='sm'
                                className='w-fit'
                                onClick={() => update('materials', { roots: [...draft.materials.roots, ''] })}
                            >
                                <PlusIcon />
                                フォルダを追加
                            </Button>
                        </div>
                    </Section>
                    <Section title='読み込める拡張子'>
                        <Row id='extensions' label='拡張子' description='カンマ区切りで書きます'>
                            <Input
                                id='extensions'
                                className='w-56'
                                value={draft.materials.extensions.join(', ')}
                                onChange={(e) => update('materials', { extensions: e.target.value.split(',') })}
                            />
                        </Row>
                    </Section>
                </TabsContent>

                <TabsContent value='display' className='min-h-0 overflow-y-auto pr-2'>
                    <Section>
                        <Row
                            id='session-meta'
                            label='サイドバーの録音日時と長さ'
                            description='セッションのタイトルの下に小さく表示します'
                        >
                            <Switch
                                id='session-meta'
                                checked={draft.display.sessionMeta}
                                onCheckedChange={(sessionMeta) => update('display', { sessionMeta })}
                            />
                        </Row>
                        <Row
                            id='show-picked-terms'
                            label='用語リスト（文字起こし抽出）の表示'
                            description='文字起こしのタブの上に一覧を表示し、誤った語は × で外せます。オフでも用語リストは使います。抽出するかは「録音中の用語抽出」で決めます'
                        >
                            <Switch
                                id='show-picked-terms'
                                checked={draft.display.showPickedTerms ?? false}
                                onCheckedChange={(showPickedTerms) => update('display', { showPickedTerms })}
                            />
                        </Row>
                        <Row
                            id='show-speakers'
                            label='話者の表示'
                            description='浄書済み文字起こしの行の頭と版の選択肢に、話者を表示します（オフでも話者は分けて保存します）'
                        >
                            <Switch
                                id='show-speakers'
                                checked={draft.display.showSpeakers ?? false}
                                onCheckedChange={(showSpeakers) => update('display', { showSpeakers })}
                            />
                        </Row>
                        <Row
                            id='mic-shortcut'
                            label='マイクボタンのショートカット'
                            description='マイクボタンを押したのと同じ動きになります。文字の入力中や、設定などを開いているときは効きません'
                        >
                            <ShortcutInput
                                id='mic-shortcut'
                                value={draft.display.micShortcut ?? DEFAULT_MIC_SHORTCUT}
                                onChange={(micShortcut) => update('display', { micShortcut })}
                            />
                        </Row>
                        {/* 端末ごとの設定（#245）。全体設定の保存とは別に、切り替えたときに効く */}
                        <PushToggle />
                    </Section>
                </TabsContent>
            </Tabs>
            <DialogFooter className='sm:items-center'>
                {/* バージョンは左下に。スマホの幅（縦に逆順で並ぶ）ではボタンの下に回る */}
                <div className='order-first sm:mr-auto'>
                    <VersionInfo />
                </div>
                <DialogClose asChild>
                    <Button variant='outline'>キャンセル</Button>
                </DialogClose>
                <Button onClick={save}>保存</Button>
            </DialogFooter>
        </>
    );
}

function NumberInput({
    id,
    value,
    min,
    max,
    step = 1,
    unit,
    onChange,
}: {
    id: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    onChange: (value: number) => void;
}) {
    return (
        <div className='flex shrink-0 items-center gap-2'>
            <Input
                id={id}
                type='number'
                className='w-24 text-right'
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(e) => onChange(e.target.valueAsNumber || 0)}
            />
            {unit && <span className='w-10 text-xs text-muted-foreground'>{unit}</span>}
        </div>
    );
}
