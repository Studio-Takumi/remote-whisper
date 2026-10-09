import { MicIcon, MicOffIcon, PauseIcon, PlayIcon, PlusIcon, SquareIcon } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { currentProject, currentSession, useAppStore } from '@/store';
import { formatElapsed } from '@/time';

// 待機中に押したら何が起きるか
// none: プロジェクトを選んでいない / new: 新しいセッションの画面 / session: 既存のセッションを開いている
type MicTarget = { kind: 'none' } | { kind: 'new' } | { kind: 'session'; projectName: string };

// sticky + mx-auto で、サイドバーの開閉に関係なくメイン領域の中央下に置く
// 大きいボタンは開始・一時停止・再開。録音を終えるのは取り返しがつかないので、右横の小さいボタンに分ける
// 小さいボタンと経過時間は、マイクボタンが中央からずれないよう絶対配置にする
export function MicButton() {
    const state = useAppStore((s) => s.recordingState);
    const elapsed = useAppStore((s) => s.elapsed);
    const projectName = useAppStore((s) => currentProject(s)?.name);
    const hasSession = useAppStore((s) => currentSession(s) !== undefined);
    const onStart = useAppStore((s) => s.startRecording);
    const onStop = useAppStore((s) => s.stopRecording);
    const onPause = useAppStore((s) => s.pauseRecording);
    const onResume = useAppStore((s) => s.resumeRecording);
    const level = useAppStore((s) => s.micLevel);
    const micDenied = useAppStore((s) => s.server.microphone === 'denied');

    const target: MicTarget =
        projectName === undefined ? { kind: 'none' } : hasSession ? { kind: 'session', projectName } : { kind: 'new' };

    const main =
        state === 'recording'
            ? {
                  onClick: onPause,
                  label: 'クリックして一時停止',
                  color: 'bg-red-500',
                  icon: <PauseIcon size={56} fill='currentColor' />,
              }
            : state === 'paused'
              ? {
                    onClick: onResume,
                    label: 'クリックして録音再開',
                    color: 'bg-amber-500',
                    icon: <PlayIcon size={56} fill='currentColor' />,
                }
              : target.kind === 'session'
                ? {
                      onClick: onStart,
                      label: `クリックして「${target.projectName}」に新しいセッションを作成`,
                      color: 'bg-neutral-500',
                      icon: <PlusIcon size={64} />,
                  }
                : target.kind === 'new' && micDenied
                  ? {
                        // 押すともう一度マイクの許可を求める（ブラウザの設定で許可し直した場合のため）
                        onClick: onStart,
                        label: 'マイクが許可されていません。ブラウザの設定でマイクを許可してください',
                        color: 'bg-blue-500 opacity-50',
                        icon: <MicOffIcon size={64} />,
                    }
                  : target.kind === 'new'
                    ? {
                          onClick: onStart,
                          label: 'クリックして録音開始',
                          color: 'bg-blue-500',
                          icon: <MicIcon size={64} />,
                      }
                    : {
                          onClick: onStart,
                          label: '録音するプロジェクトを左のメニューから選んでください',
                          color: 'cursor-not-allowed bg-blue-500 opacity-50',
                          icon: <MicIcon size={64} />,
                      };

    // 録音中は上に経過時間を出すので、Tooltip は左右に出して被らないようにする
    const recording = state !== 'idle';

    return (
        <div className='sticky bottom-8 mx-auto mt-auto shrink-0'>
            {recording && (
                <p
                    className={`absolute bottom-full left-1/2 mb-6 -translate-x-1/2 font-mono text-lg tabular-nums ${state === 'paused' ? 'animate-pulse text-muted-foreground' : ''}`}
                >
                    {formatElapsed(elapsed)}
                </p>
            )}

            {/* 録音中は、マイクの音量に合わせて後ろの輪を広げる。最大で 16px はみ出すので、経過時間と終了ボタンはその外に置く */}
            {state === 'recording' && (
                <span
                    aria-hidden
                    className='absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-100'
                    style={{ transform: `scale(${1 + Math.min(1, level * 5) * 0.25})` }}
                />
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        className={`relative flex h-32 w-32 items-center justify-center rounded-full text-white transition-colors ${main.color}`}
                        onClick={main.onClick}
                        aria-label={main.label}
                    >
                        {main.icon}
                    </button>
                </TooltipTrigger>
                <TooltipContent side={recording ? 'left' : 'top'}>{main.label}</TooltipContent>
            </Tooltip>

            {recording && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className='absolute top-1/2 left-full ml-6 flex size-12 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-foreground shadow-sm transition-colors hover:bg-muted'
                            onClick={onStop}
                            aria-label='クリックして録音終了'
                        >
                            <SquareIcon className='size-4' fill='currentColor' />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side='right'>クリックして録音終了</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
