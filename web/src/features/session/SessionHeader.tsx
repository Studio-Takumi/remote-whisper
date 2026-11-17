import { FileAudioIcon, MicIcon } from 'lucide-react';

import type { Session } from '@/api/types';
import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import { recordingLocks } from '@/features/recording/recording';
import { describeWatched } from '@/features/recording/watch';
import { JoinedSourceChips } from '@/features/session/SourceList';
import { canJoin } from '@/features/session/sessionContent';

// 開いているセッションのタイトルと状態。途中で終わったものは続きから録音できる
export function SessionHeader({ session }: { session: Session }) {
    const recordingState = useAppStore((s) => s.recordingState);
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    // ほかの端末で録音中のセッションを見ている（#238）
    const watching = useAppStore((s) => s.watching);
    // このマイクで参加している（#356。閲覧専用ではない）。参加はマイクボタンで（#357）
    const joinedHere = useAppStore((s) => s.joined !== null && s.joined.sessionId === s.selection.sessionId);
    const continueRecording = useAppStore((s) => s.continueRecording);
    return (
        <div>
            <h1 className='text-lg font-semibold'>
                {session.title}
                {session.provisionalTitle && (
                    <span className='ml-2 text-xs font-normal text-muted-foreground'>（仮のタイトル）</span>
                )}
            </h1>
            <p className='text-xs text-muted-foreground'>
                {session.startedAt}
                {session.status === 'recording' &&
                    (session.id === recordingSessionId
                        ? '・録音中'
                        : `・${describeWatched(watching?.sessionId === session.id ? watching.state : undefined)}${joinedHere || canJoin(watching, session.id) ? '' : '（この端末では閲覧専用です）'}`)}
                {/* 録音している端末には、参加している音源を出す（#357） */}
                {session.id === recordingSessionId && <JoinedSourceChips sessionId={session.id} />}
                {session.status === 'interrupted' && '・途中で中断'}
                {session.uploaded && (
                    <span className='ml-2 inline-flex items-center gap-1 align-middle'>
                        <FileAudioIcon className='size-3' />
                        音声ファイルから作成
                    </span>
                )}
            </p>
            {/* 途中で終わったセッションは、同じセッションのまま続きを録音できる（#101）。
                録音ファイルがまだ mp3 になっていない（WAV のまま）こともあるので、ファイルの有無では隠さない
                （残っていなければ、サーバーが断る） */}
            {session.status === 'interrupted' && (
                <div className='mt-2 flex flex-col items-start gap-1'>
                    <Button
                        variant='outline'
                        size='sm'
                        disabled={recordingState !== 'idle'}
                        onClick={() => void continueRecording(session.id)}
                    >
                        <MicIcon />
                        続きから録音
                    </Button>
                    {recordingState !== 'idle' && (
                        <p className='text-xs text-muted-foreground'>{recordingLocks.continueRecording}</p>
                    )}
                </div>
            )}
        </div>
    );
}
