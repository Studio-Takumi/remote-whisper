// マイクボタンを押したら何をするかと、その見た目（spec/ui.md 8）
import type { WatchedState } from '@/api/protocol';
import { describeLeft } from '@/features/recording/continueWindow';
import { recordingMessages } from '@/features/recording/i18n';
import type { Joined } from '@/features/recording/join';
import type { RecordingState } from '@/features/recording/recording';
import { describeWatched } from '@/features/recording/watch';

// 待機中に押したら何が起きるか
// none: プロジェクトを選んでいない / new: 新しいセッションの画面 / session: 既存のセッションを開いている
export type MicTarget = { kind: 'none' } | { kind: 'new' } | { kind: 'session'; projectName: string };

export type MicDo = 'back' | 'pause' | 'resume' | 'leave' | 'join' | 'notice' | 'continue' | 'start';
// leave は参加中（録音中の操作と同じく小さく）、micOff はマイクが許可されていないとき（待機中と同じく大きく）
export type MicIcon = 'back' | 'pause' | 'play' | 'leave' | 'micOff' | 'mic' | 'radio' | 'plus';

// do は押したときの動き（notice は理由を出すだけ）。hint はタッチのときにボタンの上に出す短い説明
export type MicAction = {
    do: MicDo;
    label: string;
    hint: string;
    color: string;
    icon: MicIcon;
    disabled?: boolean;
    // 押せない理由は、タッチでなくても出す
    showHint?: boolean;
    notice?: string;
};

export type MicSituation = {
    state: RecordingState;
    // 録音中に別のセッション（または新しいセッションの画面）を開いている（#133）
    elsewhere: boolean;
    recordingTitle: string | undefined;
    // 開いているセッションを、ほかの端末で録音している（#238）
    watchedElsewhere: boolean;
    watchedState: WatchedState | undefined;
    joinedHere: boolean;
    joinedLabel: string;
    // 参加できないときの理由。null なら参加できる。undefined はまだ分からない
    joinReason: string | null | undefined;
    // 続きから録音できる残りの秒数（#174）。続けられないなら null
    continueLeft: number | null;
    windowMin: number;
    target: MicTarget;
    micDenied: boolean;
};

// 参加している間に出す「参加中」（#357）。つなぎ直している間・返事待ちはそう出す
export function describeJoined(joined: Joined) {
    if (joined.state === 'reconnecting') {
        return recordingMessages.t('micAction.reconnecting');
    }
    if (joined.state === 'joining' || joined.source === null) {
        return recordingMessages.t('micAction.joining');
    }
    return recordingMessages.t('micAction.joined', { source: joined.source });
}

// 録音中・参加中のボタン。録音中に別のセッションを開いているときは、録音中のセッションに戻るボタンにする
function activeAction(s: MicSituation): MicAction | null {
    if (s.elsewhere) {
        const paused = s.state === 'paused';
        const title = s.recordingTitle ?? recordingMessages.t('common.newSession');
        return {
            do: 'back',
            label: paused
                ? recordingMessages.t('micAction.backPaused', { title })
                : recordingMessages.t('micAction.backRecording', { title }),
            hint: '',
            color: paused ? 'bg-amber-500' : 'bg-red-500',
            icon: 'back',
        };
    }
    if (s.state === 'recording') {
        return {
            do: 'pause',
            label: recordingMessages.t('micAction.pause'),
            hint: '',
            color: 'bg-red-500',
            icon: 'pause',
        };
    }
    if (s.state === 'paused') {
        return {
            do: 'resume',
            label: recordingMessages.t('micAction.resume'),
            hint: '',
            color: 'bg-amber-500',
            icon: 'play',
        };
    }
    if (s.watchedElsewhere && s.joinedHere) {
        // この端末のマイクで参加している（#357）。押すと抜ける。録音の操作（一時停止・終了）はできない
        return {
            do: 'leave',
            label: recordingMessages.t('micAction.leave', { joined: s.joinedLabel }),
            hint: '',
            color: 'bg-red-500',
            icon: 'leave',
        };
    }
    return null;
}

// ほかの端末で録音中のセッションを見ているときのボタン（#238）。参加できれば参加する（#357）
function watchingAction(s: MicSituation): MicAction {
    const watched = describeWatched(s.watchedState);
    if (s.joinReason === null) {
        return {
            do: 'join',
            label: recordingMessages.t('micAction.join', { watched }),
            hint: recordingMessages.t('micAction.joinHint'),
            color: 'bg-blue-500',
            icon: 'mic',
        };
    }
    // 参加できない（古いホスト・上限・参加を切っている・ほかのセッションに参加している）。理由を出す
    return {
        do: 'notice',
        notice: s.joinReason ?? recordingMessages.t('micAction.notice'),
        label: recordingMessages.t('micAction.watched', {
            watched,
            reason: s.joinReason ?? recordingMessages.t('micAction.viewOnly'),
        }),
        hint: s.joinReason ?? watched,
        color: 'cursor-not-allowed bg-neutral-400 dark:bg-neutral-600',
        icon: 'radio',
        disabled: true,
        showHint: true,
    };
}

// 待機中のボタン。続きから録音・新しいセッション・録音開始
function idleAction(s: MicSituation): MicAction {
    if (s.continueLeft !== null) {
        return {
            do: 'continue',
            label: recordingMessages.t('micAction.continue', {
                min: s.windowMin,
                left: describeLeft(s.continueLeft),
            }),
            hint: recordingMessages.t('micAction.continueHint'),
            color: 'bg-blue-500',
            icon: 'mic',
        };
    }
    if (s.target.kind === 'session') {
        return {
            do: 'start',
            label: recordingMessages.t('micAction.newSession', { project: s.target.projectName }),
            hint: recordingMessages.t('micAction.newSessionHint'),
            color: 'bg-neutral-500',
            icon: 'plus',
        };
    }
    if (s.target.kind === 'new') {
        // マイクが許可されていなくても、押すともう一度許可を求める（ブラウザの設定で許可し直した場合のため）
        return s.micDenied
            ? {
                  do: 'start',
                  label: recordingMessages.t('micAction.micDenied'),
                  hint: recordingMessages.t('micAction.micDeniedHint'),
                  color: 'bg-blue-500 opacity-50',
                  icon: 'micOff',
              }
            : {
                  do: 'start',
                  label: recordingMessages.t('micAction.start'),
                  hint: recordingMessages.t('micAction.startHint'),
                  color: 'bg-blue-500',
                  icon: 'mic',
              };
    }
    return {
        do: 'start',
        label: recordingMessages.t('common.chooseProject'),
        hint: recordingMessages.t('micAction.chooseProjectHint'),
        color: 'cursor-not-allowed bg-blue-500 opacity-50',
        icon: 'mic',
    };
}

export function micAction(s: MicSituation): MicAction {
    return activeAction(s) ?? (s.watchedElsewhere ? watchingAction(s) : idleAction(s));
}
