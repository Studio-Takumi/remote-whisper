import { useEffect, useState } from 'react';

import { RefreshCwIcon } from 'lucide-react';

import { pickFinalTranscript } from '@/api/transcripts';
import type { FinalTranscriptInfo, Session } from '@/api/types';
import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { recordingLocks } from '@/features/recording/recording';
import { StatusIndicator } from '@/features/session/StatusIndicator';
import { sessionMessages } from '@/features/session/i18n';
import { generationLabel } from '@/features/session/transcriptGenerations';
import { useT } from '@/i18n/messages';

// 最終の文字起こし（#121）の世代の切り替えと作り直し。作っている途中なら、そう出す
export function FinalTranscriptBar({ session, making }: { session: Session; making: boolean }) {
    const t = useT(sessionMessages);
    const whisperModel = useAppStore((s) => s.settings.whisper.model);
    // 最終の文字起こし（WhisperX）を作れるサーバーか。古いサーバーは返さないので、作れないものとする
    const available = useAppStore((s) => s.options.whisper.finalTranscript === true);
    const regenerate = useAppStore((s) => s.regenerateFinalTranscript);
    const pick = useAppStore((s) => s.showFinalTranscript);
    // 世代の選択肢に話者の数を出すか（全体設定 display.showSpeakers、#146）
    const showSpeakers = useAppStore((s) => s.settings.display.showSpeakers ?? false);
    // 録音中は作り直せない（GPU を長く使い、録音中の文字起こしが止まるため。#133）
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const final = session.finalTranscript;
    const generations = session.finalTranscripts ?? [];
    // 手で選んだ世代。セッションを替えたときと、世代が増えた（作り直した）ときは既定に戻す（要約と同じ）
    const [picked, setPicked] = useState<{ sessionId: string; count: number } | null>(null);
    const pickedByHand = picked?.sessionId === session.id && picked.count === generations.length;
    // 既定の世代（今の Whisper のモデルのうちいちばん新しいもの）。モデルを変えたら選び直す
    const preferred = pickFinalTranscript(generations, whisperModel)?.generationId;
    const shown = final?.generationId;
    useEffect(() => {
        if (shown && preferred && preferred !== shown && !pickedByHand) {
            void pick(session.id, preferred);
        }
    }, [shown, preferred, pickedByHand, pick, session.id]);

    // 作り直せるのは、録音を終えて録音ファイルが残っているセッション（#124。spec/ui.md 8）。
    // 手元で録音した直後は files がないので、消えたと分かっているときだけ出さない（#273）
    const done = session.status !== 'recording' && session.loaded === true;
    const regenerateButton = available && done && session.files?.recording !== false && !making && (
        <Button
            variant='outline'
            size='sm'
            className='h-7'
            disabled={recording}
            title={recording ? recordingLocks.regenerate : undefined}
            onClick={() => void regenerate(session.id)}
        >
            <RefreshCwIcon />
            {t(final ? 'finalTranscriptBar.regenerate' : 'finalTranscriptBar.transcribe', { model: whisperModel })}
        </Button>
    );
    const locked = regenerateButton && recording && (
        <p className='text-xs text-muted-foreground'>{recordingLocks.regenerate}</p>
    );
    const status = making && (
        <StatusIndicator
            status={{
                tone: 'active',
                text: final ? t('finalTranscriptBar.makingAgain') : t('finalTranscriptBar.making'),
            }}
        />
    );
    const noRecording = available && done && session.files?.recording === false && (
        <p className='text-xs text-muted-foreground'>{t('finalTranscriptBar.noRecording')}</p>
    );

    if (!final) {
        if (status) {
            return status;
        }
        // 最終の文字起こしがまだない（作らない設定だった・作れなかった・機能を入れる前のセッション）
        return regenerateButton ? (
            <div className='flex flex-col items-start gap-1'>
                {regenerateButton}
                {locked}
            </div>
        ) : (
            noRecording || null
        );
    }
    const label = (g: FinalTranscriptInfo) => generationLabel(g, showSpeakers);
    return (
        <div className='flex flex-col gap-1'>
            <div className='flex flex-wrap items-center gap-2'>
                {generations.length > 1 ? (
                    // 作り直した世代を切り替える（要約と同じ。#124）
                    <Select
                        value={final.generationId}
                        onValueChange={(generationId) => {
                            setPicked({ sessionId: session.id, count: generations.length });
                            void pick(session.id, generationId);
                        }}
                    >
                        <SelectTrigger
                            size='sm'
                            className='text-xs'
                            aria-label={t('finalTranscriptBar.generationPicker')}
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {generations.map((g) => (
                                <SelectItem key={g.generationId} value={g.generationId} className='text-xs'>
                                    {label(g)}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                ) : (
                    <span className='text-xs text-muted-foreground'>
                        {t('finalTranscriptBar.generationLabel', { label: label(final) })}
                    </span>
                )}
                {regenerateButton}
            </div>
            {final.model !== whisperModel && (
                <p className='text-xs text-muted-foreground'>
                    {t('finalTranscriptBar.notYetForModel', { model: whisperModel })}
                </p>
            )}
            {final.diarization === 'unavailable' && (
                <p className='text-xs text-muted-foreground'>{t('finalTranscriptBar.diarizationUnavailable')}</p>
            )}
            {noRecording}
            {locked}
            {status}
        </div>
    );
}
