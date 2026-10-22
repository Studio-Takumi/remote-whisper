import { useEffect, useRef, useState } from 'react';

import { MicIcon, MicOffIcon, PauseIcon, PlayIcon, PlusIcon, RadioIcon, SquareIcon, Undo2Icon } from 'lucide-react';
import { toast } from 'sonner';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { continueLeftSec, describeLeft } from '@/continueWindow';
import { DEFAULT_MIC_SHORTCUT, ariaShortcut, formatShortcut, shouldHandleMicShortcut } from '@/shortcut';
import { currentProject, currentSession, useAppStore } from '@/store';
import { formatElapsed } from '@/time';
import type { Session } from '@/types';
import { describeWatched, recordedElsewhere } from '@/watch';

// 開いているセッションの続きから録音できる残りの秒数（#174）。続けられないなら null。
// 続けられる間だけ 5 秒ごとに時計を進める（時間を過ぎてもしばらく「続きから録音」のまま、に
// ならないよう短めにする。ずっと前に終えたセッションでは動かさない）
function useContinueLeft(session: Session | undefined, windowMin: number, idle: boolean) {
    const [now, setNow] = useState(() => Date.now());
    const left = session && idle ? continueLeftSec(session, windowMin, now) : null;
    const active = left !== null;
    useEffect(() => {
        if (!active) {
            return;
        }
        const tick = () => setNow(Date.now());
        // 止まっていた間に古くなった時刻は、すぐ取り直す
        const first = setTimeout(tick, 0);
        const timer = setInterval(tick, 5000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [active]);
    return left;
}

// マイクボタンのキーボードのショートカット（#236）。押すとマイクボタンを押したのと同じ動きにする。
// 文字を入力している途中・モーダルを開いているときは効かない（shortcut.ts）
function useMicShortcut(combo: string, onPress: () => void) {
    const press = useRef(onPress);
    useEffect(() => {
        press.current = onPress;
    });
    useEffect(() => {
        if (combo === '') {
            return;
        }
        const onKeyDown = (e: KeyboardEvent) => {
            if (!shouldHandleMicShortcut(e, combo)) {
                return;
            }
            e.preventDefault();
            press.current();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [combo]);
}

// アイコンの大きさ。スマホの幅ではボタンが小さいので、アイコンも小さくする
const smallIcon = 'size-10 md:size-14';
const largeIcon = 'size-12 md:size-16';

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
    // 録音中に別のセッション（または新しいセッションの画面）を開いているか（#133）
    const elsewhere = useAppStore(
        (s) => s.recordingSessionId !== null && s.selection.sessionId !== s.recordingSessionId,
    );
    const recordingTitle = useAppStore(
        (s) => s.projects.flatMap((p) => p.sessions).find((x) => x.id === s.recordingSessionId)?.title,
    );
    const onBack = useAppStore((s) => s.showRecordingSession);
    const onContinue = useAppStore((s) => s.continueRecording);
    // 開いているセッションを、録音を終えてからしばらくは続きから録音できる（#174）
    const session = useAppStore(currentSession);
    const windowMin = useAppStore((s) => s.settings.recording.continueWindowMin);
    const continueLeft = useContinueLeft(session, windowMin, state === 'idle');
    // 開いているセッションを、ほかの端末で録音している（#238）
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    const watchedElsewhere = recordedElsewhere(session, recordingSessionId);
    const watchedState = useAppStore((s) =>
        s.watching && s.watching.sessionId === session?.id ? s.watching.state : undefined,
    );

    const target: MicTarget =
        projectName === undefined ? { kind: 'none' } : hasSession ? { kind: 'session', projectName } : { kind: 'new' };

    // 録音中に別のセッションを開いているときは、録音を始めずに録音中のセッションに戻るボタンにする。
    // 一時停止・終了は、録音中のセッションの画面でだけ出す
    const main = elsewhere
        ? {
              onClick: onBack,
              label: `「${recordingTitle ?? '新しいセッション'}」で${state === 'paused' ? '一時停止中' : '録音中'}です。クリックで戻ります`,
              hint: '',
              color: state === 'paused' ? 'bg-amber-500' : 'bg-red-500',
              icon: <Undo2Icon className={smallIcon} />,
          }
        : state === 'recording'
          ? {
                onClick: onPause,
                label: 'クリックして一時停止',
                hint: '',
                color: 'bg-red-500',
                icon: <PauseIcon className={smallIcon} fill='currentColor' />,
            }
          : state === 'paused'
            ? {
                  onClick: onResume,
                  label: 'クリックして録音再開',
                  hint: '',
                  color: 'bg-amber-500',
                  icon: <PlayIcon className={smallIcon} fill='currentColor' />,
              }
            : watchedElsewhere
              ? {
                    // ほかの端末で録音中のセッションを見ている（#238）。見るだけで、録音の操作はできない
                    onClick: () => toast.info('ほかの端末で録音中です。操作はその端末でしてください'),
                    label: `${describeWatched(watchedState)}です。この端末では見るだけです`,
                    hint: describeWatched(watchedState),
                    color: 'cursor-not-allowed bg-neutral-400 dark:bg-neutral-600',
                    icon: <RadioIcon className={largeIcon} />,
                    disabled: true,
                }
              : session && continueLeft !== null
                ? {
                      onClick: () => void onContinue(session.id),
                      label: `クリックして続きから録音（録音を終えてから ${windowMin} 分の間は、続きから録音できます。${describeLeft(continueLeft)}）`,
                      hint: '押すと続きから録音',
                      color: 'bg-blue-500',
                      icon: <MicIcon className={largeIcon} />,
                  }
                : target.kind === 'session'
                  ? {
                        onClick: onStart,
                        label: `クリックして「${target.projectName}」に新しいセッションを作成`,
                        hint: '押すと新しいセッション',
                        color: 'bg-neutral-500',
                        icon: <PlusIcon className={largeIcon} />,
                    }
                  : target.kind === 'new' && micDenied
                    ? {
                          // 押すともう一度マイクの許可を求める（ブラウザの設定で許可し直した場合のため）
                          onClick: onStart,
                          label: 'マイクが許可されていません。ブラウザの設定でマイクを許可してください',
                          hint: 'マイクが許可されていません',
                          color: 'bg-blue-500 opacity-50',
                          icon: <MicOffIcon className={largeIcon} />,
                      }
                    : target.kind === 'new'
                      ? {
                            onClick: onStart,
                            label: 'クリックして録音開始',
                            hint: '押すと録音開始',
                            color: 'bg-blue-500',
                            icon: <MicIcon className={largeIcon} />,
                        }
                      : {
                            onClick: onStart,
                            label: '録音するプロジェクトをメニューから選んでください',
                            hint: 'プロジェクトを選んでください',
                            color: 'cursor-not-allowed bg-blue-500 opacity-50',
                            icon: <MicIcon className={largeIcon} />,
                        };

    const shortcut = useAppStore((s) => s.settings.display.micShortcut ?? DEFAULT_MIC_SHORTCUT);
    useMicShortcut(shortcut, main.onClick);

    // 録音中は上に経過時間を出すので、Tooltip は左右に出して被らないようにする
    const recording = state !== 'idle';

    return (
        // スマホでは画面の下端（ホームバーなど）を避ける
        <div className='sticky bottom-[calc(1.5rem+env(safe-area-inset-bottom))] mx-auto mt-auto shrink-0 md:bottom-8'>
            {/* タッチではツールチップが出ないので、待機中はボタンの上に短い説明を出す */}
            {!recording && (
                <p className='absolute bottom-full left-1/2 mb-3 hidden -translate-x-1/2 rounded-full bg-background/90 px-2 py-0.5 text-xs whitespace-nowrap text-muted-foreground shadow-sm pointer-coarse:block'>
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

            {/* 録音中は、マイクの音量に合わせて後ろの輪を広げる。最大で 16px はみ出すので、経過時間と終了ボタンはその外に置く */}
            {state === 'recording' && !elsewhere && (
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
                        onClick={main.onClick}
                        aria-label={main.label}
                        aria-disabled={'disabled' in main && main.disabled ? true : undefined}
                        aria-keyshortcuts={ariaShortcut(shortcut)}
                    >
                        {main.icon}
                    </button>
                </TooltipTrigger>
                <TooltipContent side={recording ? 'left' : 'top'}>
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
