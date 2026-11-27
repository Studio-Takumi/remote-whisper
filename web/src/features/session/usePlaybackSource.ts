import { type RefObject, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { Session } from '@/api/types';
import { sessionMessages } from '@/features/session/i18n';
import { playableSources, recordingQuery, toMainTime, toSourceTime } from '@/features/session/sourcePlayback';
import { sourceLabel } from '@/features/session/sources';

// 再生する音源の切り替え（#371。spec/ui.md 8）。既定は主の音源。切り替えても再生位置（主の音源の時刻）を保ち、
// 行の時刻を押したときも選んでいる音源で再生する。選べないとき（音源が 1 つ・古いサーバー）は今までと同じ
export function usePlaybackSource(session: Session | undefined, audio: RefObject<HTMLAudioElement | null>) {
    const sessionId = session?.id;
    const playable = useMemo(
        () => playableSources(session?.sources, session?.files?.sourceRecordings),
        [session?.sources, session?.files?.sourceRecordings],
    );
    // 選んだ音源と知らせ。ほかのセッションを開いたら主の音源に戻す（セッション ID と一緒に持つ）
    const [choice, setChoice] = useState<{ sessionId: string; id: number } | null>(null);
    const [notice, setNotice] = useState<{ sessionId: string; text: string } | null>(null);
    const selected =
        choice && choice.sessionId === sessionId && playable.some((s) => s.id === choice.id) ? choice.id : 1;
    const current = playable.find((s) => s.id === selected);
    // seek を作り直さない（行を全部描き直さない）ように、今の音源は ref で読む
    const currentRef = useRef(current);
    useLayoutEffect(() => {
        currentRef.current = current;
    }, [current]);
    // 切り替えたあと、読み込めたら合わせる位置（主の音源の時刻）と、再生を続けるか
    const pending = useRef<{ main: number; play: boolean } | null>(null);

    const say = useCallback(
        (text: string | null) => setNotice(text && sessionId ? { sessionId, text } : null),
        [sessionId],
    );

    // 主の音源の時刻 mainSec から再生する。その音源の録音がない時刻なら止めて知らせる
    const playAt = useCallback(
        (el: HTMLAudioElement, mainSec: number, play: boolean) => {
            const sec = toSourceTime(mainSec, currentRef.current, el.duration);
            if (sec === null) {
                el.pause();
                say(sessionMessages.t('usePlaybackSource.noRecordingAt'));
                return;
            }
            say(null);
            el.currentTime = sec;
            if (play) {
                // 読み込めないときなどは、onError で再生バーを消す
                el.play().catch(() => {});
            }
        },
        [say],
    );

    const select = (id: number) => {
        const el = audio.current;
        if (id === selected || !sessionId) {
            return;
        }
        if (el) {
            pending.current = { main: toMainTime(el.currentTime, current), play: !el.paused };
        }
        say(null);
        setChoice({ sessionId, id });
    };

    const onLoaded = (el: HTMLAudioElement) => {
        const p = pending.current;
        pending.current = null;
        if (p) {
            playAt(el, p.main, p.play);
        }
    };

    const seek = useCallback(
        (mainSec: number) => {
            const el = audio.current;
            if (el) {
                playAt(el, mainSec, true);
            }
        },
        [audio, playAt],
    );

    // 再生バーの位置（その音源のファイルの時刻）を、主の音源の時刻に直す（再生中の行に印を付けるため）
    const mainTime = useCallback((sec: number) => toMainTime(sec, currentRef.current), []);

    // ほかの音源の録音を読み込めなかったら、主の音源に戻して知らせる（true）。主の音源なら false（再生バーを消す）
    const failed = () => {
        if (selected === 1 || !sessionId) {
            return false;
        }
        pending.current = null;
        setChoice({ sessionId, id: 1 });
        say(sessionMessages.t('usePlaybackSource.loadFailed', { source: sourceLabel(selected) }));
        return true;
    };

    return {
        playable,
        selected,
        select,
        query: recordingQuery(selected),
        onLoaded,
        seek,
        mainTime,
        failed,
        notice: notice && notice.sessionId === sessionId ? notice.text : null,
        clearNotice: () => say(null),
    };
}
