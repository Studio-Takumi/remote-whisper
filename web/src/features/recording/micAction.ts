// マイクボタンを押したら何をするかと、その見た目（spec/ui.md 8）
import type { WatchedState } from '@/api/protocol';
import { describeLeft } from '@/features/recording/continueWindow';
import type { Joined } from '@/features/recording/join';
import type { RecordingState } from '@/features/recording/recording';
import { describeWatched } from '@/features/recording/watch';

// 待機中に押したら何が起きるか
// none: プロジェクトを選んでいない / new: 新しいセッションの画面 / session: 既存のセッションを開いている
export type MicTarget = { kind: 'none' } | { kind: 'new' } | { kind: 'session'; projectName: string };

export type MicDo = 'back' | 'pause' | 'resume' | 'leave' | 'join' | 'notice' | 'continue' | 'start';
export type MicIcon = 'back' | 'pause' | 'play' | 'micOff' | 'mic' | 'radio' | 'plus';

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
        return 'ホストにつなぎ直しています';
    }
    if (joined.state === 'joining' || joined.source === null) {
        return '参加しています…';
    }
    return `音源 ${joined.source} として参加中`;
}

// 録音中・参加中のボタン。録音中に別のセッションを開いているときは、録音中のセッションに戻るボタンにする
function activeAction(s: MicSituation): MicAction | null {
    if (s.elsewhere) {
        const paused = s.state === 'paused';
        return {
            do: 'back',
            label: `「${s.recordingTitle ?? '新しいセッション'}」で${paused ? '一時停止中' : '録音中'}です。クリックで戻ります`,
            hint: '',
            color: paused ? 'bg-amber-500' : 'bg-red-500',
            icon: 'back',
        };
    }
    if (s.state === 'recording') {
        return { do: 'pause', label: 'クリックして一時停止', hint: '', color: 'bg-red-500', icon: 'pause' };
    }
    if (s.state === 'paused') {
        return { do: 'resume', label: 'クリックして録音再開', hint: '', color: 'bg-amber-500', icon: 'play' };
    }
    if (s.watchedElsewhere && s.joinedHere) {
        // この端末のマイクで参加している（#357）。押すと抜ける。録音の操作（一時停止・終了）はできない
        return {
            do: 'leave',
            label: `${s.joinedLabel}。クリックして参加をやめる`,
            hint: '',
            color: 'bg-red-500',
            icon: 'micOff',
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
            label: `${watched}です。クリックしてこの端末のマイクで参加`,
            hint: 'この端末のマイクで参加',
            color: 'bg-blue-500',
            icon: 'mic',
        };
    }
    // 参加できない（古いホスト・上限・参加を切っている・ほかのセッションに参加している）。理由を出す
    return {
        do: 'notice',
        notice: s.joinReason ?? 'ほかの端末で録音中です。操作はその端末でしてください',
        label: `${watched}です。${s.joinReason ?? 'この端末では閲覧専用です'}`,
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
            label: `クリックして続きから録音（録音を終えてから ${s.windowMin} 分の間は、続きから録音できます。${describeLeft(s.continueLeft)}）`,
            hint: '押すと続きから録音',
            color: 'bg-blue-500',
            icon: 'mic',
        };
    }
    if (s.target.kind === 'session') {
        return {
            do: 'start',
            label: `クリックして「${s.target.projectName}」に新しいセッションを作成`,
            hint: '押すと新しいセッション',
            color: 'bg-neutral-500',
            icon: 'plus',
        };
    }
    if (s.target.kind === 'new') {
        // マイクが許可されていなくても、押すともう一度許可を求める（ブラウザの設定で許可し直した場合のため）
        return s.micDenied
            ? {
                  do: 'start',
                  label: 'マイクが許可されていません。ブラウザの設定でマイクを許可してください',
                  hint: 'マイクが許可されていません',
                  color: 'bg-blue-500 opacity-50',
                  icon: 'micOff',
              }
            : { do: 'start', label: 'クリックして録音開始', hint: '押すと録音開始', color: 'bg-blue-500', icon: 'mic' };
    }
    return {
        do: 'start',
        label: '録音するプロジェクトをメニューから選んでください',
        hint: 'プロジェクトを選んでください',
        color: 'cursor-not-allowed bg-blue-500 opacity-50',
        icon: 'mic',
    };
}

export function micAction(s: MicSituation): MicAction {
    return activeAction(s) ?? (s.watchedElsewhere ? watchingAction(s) : idleAction(s));
}
