import { MicIcon, MicOffIcon, PauseIcon, PlayIcon, PlusIcon, RadioIcon, SquareIcon, Undo2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { useCurrentProject, useCurrentSession, useSessionTitle } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { joinUnavailable } from '@/features/recording/join';
import { type MicDo, type MicIcon as MicIconKind, describeJoined, micAction } from '@/features/recording/micAction';
import { useContinueLeft } from '@/features/recording/useContinueLeft';
import { useMicShortcut } from '@/features/recording/useMicShortcut';
import { recordedElsewhere } from '@/features/recording/watch';
import { DEFAULT_MIC_SHORTCUT, ariaShortcut, formatShortcut } from '@/features/settings/shortcut';
import { formatElapsed } from '@/lib/time';

// アイコンの大きさ。スマホの幅ではボタンが小さいので、アイコンも小さくする（録音中の操作は小さく、待機中は大きく）
const smallIcon = 'size-10 md:size-14';
const largeIcon = 'size-12 md:size-16';

const ICONS: Record<MicIconKind, React.ReactNode> = {
    back: <Undo2Icon className={smallIcon} />,
    pause: <PauseIcon className={smallIcon} fill='currentColor' />,
    play: <PlayIcon className={smallIcon} fill='currentColor' />,
    leave: <MicOffIcon className={smallIcon} />,
    micOff: <MicOffIcon className={largeIcon} />,
    mic: <MicIcon className={largeIcon} />,
    radio: <RadioIcon className={largeIcon} />,
    plus: <PlusIcon className={largeIcon} />,
};

// sticky + mx-auto で、サイドバーの開閉に関係なくメイン領域の中央下に置く（spec/ui.md 8）。
// 小さいボタンと経過時間は、マイクボタンが中央からずれないよう絶対配置にする
export function MicButton() {
    const state = useAppStore((s) => s.recordingState);
    const elapsed = useAppStore((s) => s.elapsed);
    const projectName = useCurrentProject()?.name;
    // 開いているセッションを、録音を終えてからしばらくは続きから録音できる（#174）
    const session = useCurrentSession();
    const hasSession = session !== undefined;
    const onStart = useAppStore((s) => s.startRecording);
    const onStop = useAppStore((s) => s.stopRecording);
    const onPause = useAppStore((s) => s.pauseRecording);
    const onResume = useAppStore((s) => s.resumeRecording);
    const level = useAppStore((s) => s.micLevel);
    const micDenied = useAppStore((s) => s.server.microphone === 'denied');
    // 録音中に別のセッション（または新しいセッションの画面）を開いているか（#133）
    const elsewhere = useAppStore(
        (s) => s.recordingSessionId !== null && s.selection.sessionId !== s.recordingSessionId,
    );
    const recordingTitle = useSessionTitle(useAppStore((s) => s.recordingSessionId));
    const onBack = useAppStore((s) => s.showRecordingSession);
    const onContinue = useAppStore((s) => s.continueRecording);
    const windowMin = useAppStore((s) => s.settings.recording.continueWindowMin);
    const continueLeft = useContinueLeft(session, windowMin, state === 'idle');
    // 開いているセッションを、ほかの端末で録音している（#238）
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    const watchedElsewhere = recordedElsewhere(session, recordingSessionId);
    const watchedState = useAppStore((s) =>
        s.watching && s.watching.sessionId === session?.id ? s.watching.state : undefined,
    );
    // この端末のマイクで、見ているセッションに音源として参加する（#241・#357。spec/ui.md 8）
    const joined = useAppStore((s) => s.joined);
    const watchedHere = useAppStore((s) => s.watching !== null && s.watching.sessionId === session?.id);
    const joinAvailability = useAppStore((s) =>
        s.watching && s.watching.sessionId === session?.id ? s.watching.join : undefined,
    );
    const onJoin = useAppStore((s) => s.joinSession);
    const onLeave = useAppStore((s) => s.leaveSession);
    const joinedHere = joined !== null && joined.sessionId === session?.id;
    const joinedLabel = joinedHere ? describeJoined(joined) : '';
    // 参加できないときの理由。見始める返事（watching）がまだなら、分からないので押せなくする（理由は出さない）
    const joinReason = !watchedHere
        ? undefined
        : joined
          ? 'ほかのセッションに参加しています'
          : joinUnavailable(joinAvailability);

    const main = micAction({
        state,
        elsewhere,
        recordingTitle,
        watchedElsewhere,
        watchedState,
        joinedHere,
        joinedLabel,
        joinReason,
        continueLeft,
        windowMin,
        target:
            projectName === undefined
                ? { kind: 'none' }
                : hasSession
                  ? { kind: 'session', projectName }
                  : { kind: 'new' },
        micDenied,
    });
    const actions: Record<MicDo, () => void> = {
        back: onBack,
        pause: onPause,
        resume: onResume,
        leave: onLeave,
        join: () => session && void onJoin(session.id),
        notice: () => toast.info(main.notice),
        continue: () => session && void onContinue(session.id),
        start: onStart,
    };
    const onClick = actions[main.do];

    const shortcut = useAppStore((s) => s.settings.display.micShortcut ?? DEFAULT_MIC_SHORTCUT);
    useMicShortcut(shortcut, onClick);

    // 録音中は上に経過時間（参加中は「参加中」）を出すので、Tooltip は左右に出して被らないようにする
    const recording = state !== 'idle';
    const showJoined = !recording && watchedElsewhere && joinedHere;

    return (
        // スマホでは画面の下端（ホームバーなど）を避ける
        <div className='sticky bottom-[calc(1.5rem+env(safe-area-inset-bottom))] mx-auto mt-auto shrink-0 md:bottom-8'>
            {/* タッチではツールチップが出ないので、待機中はボタンの上に短い説明を出す（押せない理由はいつも出す） */}
            {!recording && !showJoined && main.hint && (
                <p
                    className={`absolute bottom-full left-1/2 mb-3 -translate-x-1/2 rounded-full bg-background/90 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground shadow-sm ${main.showHint ? '' : 'hidden pointer-coarse:block'}`}
                >
                    {main.hint}
                </p>
            )}
            {recording && (
                <p
                    className={`absolute bottom-full left-1/2 mb-6 -translate-x-1/2 font-mono text-lg tabular-nums ${state === 'paused' ? 'animate-pulse text-muted-foreground' : ''}`}
                >
                    {formatElapsed(elapsed)}
                </p>
            )}
            {showJoined && (
                <p
                    className={`absolute bottom-full left-1/2 mb-6 -translate-x-1/2 text-sm font-medium whitespace-nowrap ${joined?.state === 'joined' ? 'text-red-600 dark:text-red-400' : 'animate-pulse text-muted-foreground'}`}
                    role='status'
                >
                    {joinedLabel}
                </p>
            )}

            {/* 録音中・参加中は、マイクの音量に合わせて後ろの輪を広げる。最大で 16px はみ出すので、経過時間と終了ボタンはその外に置く */}
            {((state === 'recording' && !elsewhere) || showJoined) && (
                <span
                    aria-hidden
                    className='absolute inset-0 rounded-full bg-red-500/30 transition-transform duration-100'
                    style={{ transform: `scale(${1 + Math.min(1, level * 5) * 0.25})` }}
                />
            )}
            <Tooltip>
                <TooltipTrigger asChild>
                    <button
                        className={`relative flex size-24 items-center justify-center rounded-full text-white transition-colors md:size-32 ${main.color}`}
                        onClick={onClick}
                        aria-label={main.label}
                        aria-disabled={main.disabled ? true : undefined}
                        aria-keyshortcuts={ariaShortcut(shortcut)}
                    >
                        {ICONS[main.icon]}
                    </button>
                </TooltipTrigger>
                <TooltipContent side={recording || showJoined ? 'left' : 'top'}>
                    {main.label}
                    {shortcut !== '' && <kbd className='ml-2 font-sans opacity-70'>{formatShortcut(shortcut)}</kbd>}
                </TooltipContent>
            </Tooltip>

            {recording && !elsewhere && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            className='absolute top-1/2 left-full ml-6 flex size-12 -translate-y-1/2 items-center justify-center rounded-full border bg-background text-foreground shadow-sm transition-colors hover:bg-muted'
                            onClick={onStop}
                            aria-label='クリックして録音終了'
                        >
                            <SquareIcon className='size-4' fill='currentColor' />
                            <span className='absolute top-full mt-1 hidden text-xs text-muted-foreground pointer-coarse:block'>
                                終了
                            </span>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side='right'>クリックして録音終了</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
}
