import { CopyIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';
import { toast } from 'sonner';

import { llmUnavailable } from '@/api/status';
import type { Generating, Session, Summary } from '@/api/types';
import { blockInDemo } from '@/app/demoGuard';
import { useAppStore } from '@/app/store';
import { Markdown } from '@/components/Markdown';
import { copyText } from '@/components/copyMarkdown';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { recordingLocks } from '@/features/recording/recording';
import { LiveSummary } from '@/features/session/LiveSummary';
import { ShareButton } from '@/features/session/ShareButton';
import { StatusIndicator } from '@/features/session/StatusIndicator';
import { expired, shareSource } from '@/features/session/sessionContent';
import { type PickedSummary, shownSummary } from '@/features/session/summaryPick';
import {
    canRegenerateSummary,
    generatingPlaceholder,
    summaryFailureHint,
    summaryLabel,
} from '@/features/session/summaryView';
import {
    LLM_NAMES,
    type OllamaModels,
    finalModelLabel,
    isCurrentFinalSummary,
    llmBackend,
} from '@/features/settings/settings';

// 最終の要約。既定は、今選んでいるモデルの要約のうちいちばん新しいもの。なければモデルを問わずいちばん新しいもの。
// 世代が複数あれば切り替えられる（spec/flows.md 6.5）
export function SummaryPanel({
    session,
    models,
    generating,
    liveDraft,
    picked,
    onPick,
}: {
    session: Session;
    // 今の全体設定の処理ごとのモデル（最終の要約は、全体概要と要約詳細の組で見る。#178）
    models: OllamaModels;
    generating: Generating | null;
    liveDraft: { sessionId: string; text: string } | null;
    picked: PickedSummary | null;
    onPick: (picked: PickedSummary) => void;
}) {
    const regenerate = useAppStore((s) => s.regenerateSummary);
    // 選んでいる LLM につながっているか（#327）
    const backend = useAppStore((s) => llmBackend(s.settings));
    const llmDown = useAppStore((s) => llmUnavailable(s.server, backend));
    const llmName = LLM_NAMES[backend];
    // 録音中は作り直せない（GPU を長く使い、録音中の文字起こしが止まるため。#133）
    const recording = useAppStore((s) => s.recordingState !== 'idle');

    const finalModel = finalModelLabel(models);
    const summary = shownSummary(session, models, picked);

    if (generating?.sessionId === session.id) {
        const status = <StatusIndicator status={{ tone: 'active', text: `${generating.model} で要約を作成中…` }} />;
        if (generating.text.trim()) {
            return (
                <>
                    {status}
                    <Markdown streaming>{generating.text}</Markdown>
                </>
            );
        }
        // 本文が届き始めるまで（モデルの読み込み・思考・長い録音の部分ごとの要約の間）は、空にしない
        const placeholder = generatingPlaceholder(session, summary, liveDraft);
        return (
            <>
                {status}
                {placeholder && (
                    <>
                        <p className='text-xs text-muted-foreground'>{placeholder.label}</p>
                        {placeholder.live ? (
                            <LiveSummary text={placeholder.text} />
                        ) : (
                            <Markdown>{placeholder.text}</Markdown>
                        )}
                    </>
                )}
            </>
        );
    }
    const canRegenerate = canRegenerateSummary(session, generating);
    const regenerateButton = canRegenerate && (
        <div className='flex flex-col items-start gap-1'>
            <Button
                variant='outline'
                size='sm'
                disabled={recording}
                title={recording ? recordingLocks.regenerate : undefined}
                onClick={() => void regenerate(session.id)}
            >
                <RefreshCwIcon />
                {finalModel} で{summary ? '再生成する' : '要約を作る'}
            </Button>
            {recording && <p className='text-xs text-muted-foreground'>{recordingLocks.regenerate}</p>}
        </div>
    );

    // 最終の要約を作れなかったこと（spec/flows.md 6.7）。Ollama が戻っていれば、作り直しを勧める
    const failure = session.summaryFailed && session.status !== 'recording' && (
        <div
            role='alert'
            className='flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm'
        >
            <p className='flex items-center gap-1.5 font-medium text-destructive'>
                <TriangleAlertIcon className='size-4' />
                {summary ? '直近の要約の再生成に失敗しました' : '最終要約を作れませんでした'}
            </p>
            <p className='text-xs text-muted-foreground'>
                {summaryFailureHint(session, canRegenerate, llmDown, llmName)}
            </p>
            {regenerateButton}
        </div>
    );

    if (!summary) {
        // 最終の要約がまだないときは、途中の要約を代わりに出す（届いている途中なら、それを少しずつ）。
        // 下書きがまだ空（前置きだけ届いた）なら、前の要約を出しておく（#123）
        const draft = liveDraft?.sessionId === session.id && liveDraft.text ? liveDraft.text : null;
        const live = draft ?? session.liveSummary;
        if (live) {
            return (
                <>
                    {failure}
                    <p className='text-xs text-muted-foreground'>
                        リアルタイム要約{session.status === 'recording' ? '（録音中に数分おきに更新します）' : ''}
                    </p>
                    <LiveSummary text={live} streaming={draft !== null} />
                </>
            );
        }
        // 録音中は下に途中の要約の状態が出るので、何も出さない
        if (session.status === 'recording' || !session.loaded) {
            return null;
        }
        if (failure) {
            return failure;
        }
        return (
            <div className='flex flex-col items-start gap-2'>
                <p className='text-sm text-muted-foreground'>
                    {expired(session, 'summary') ? '要約は期限切れのためありません' : 'まだ要約がありません'}
                </p>
                {regenerateButton}
            </div>
        );
    }

    const label = (s: Summary) => summaryLabel(s, models);
    return (
        <>
            {failure}
            <div className='flex flex-wrap items-center gap-2'>
                {session.summaries.length > 1 ? (
                    <Select
                        value={summary.generationId}
                        onValueChange={(generationId) =>
                            onPick({ sessionId: session.id, count: session.summaries.length, generationId })
                        }
                    >
                        <SelectTrigger size='sm' className='text-xs' aria-label='表示する要約'>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {session.summaries.map((s) => (
                                <SelectItem key={s.generationId} value={s.generationId} className='text-xs'>
                                    {label(s)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <p className='text-xs text-muted-foreground'>{label(summary)}</p>
                )}
                {summary.text && (
                    <Button
                        variant='outline'
                        size='sm'
                        title='要約を Markdown のままコピーします'
                        onClick={() => {
                            if (blockInDemo('copy')) {
                                return;
                            }
                            void copyText(summary.text ?? '').then(
                                () => toast.success('要約をコピーしました'),
                                () => toast.error('要約をコピーできませんでした'),
                            );
                        }}
                    >
                        <CopyIcon />
                        コピー
                    </Button>
                )}
                {summary.text && <ShareButton source={shareSource(session, summary.text)} initial='summary' />}
                {regenerateButton}
            </div>
            {!isCurrentFinalSummary(summary, models) && (
                <p className='text-xs text-muted-foreground'>{finalModel} の要約はまだありません</p>
            )}
            <Markdown>{summary.text ?? ''}</Markdown>
        </>
    );
}
