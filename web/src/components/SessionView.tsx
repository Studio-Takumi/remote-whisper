import { useLayoutEffect, useRef, useState } from 'react';

import { AudioLinesIcon, FolderPlusIcon, RefreshCwIcon, TriangleAlertIcon } from 'lucide-react';

import { Markdown } from '@/components/Markdown';
import { RecordingPlayer } from '@/components/RecordingPlayer';
import { StatusIndicator } from '@/components/StatusIndicator';
import { Transcript } from '@/components/Transcript';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { isScrolledToBottom, scrollToBottom } from '@/scroll';
import { summaryStatus, transcriptStatus } from '@/status';
import { currentProject, currentSession, useAppStore, visibleProjects } from '@/store';
import { clockToSeconds } from '@/time';
import type { Generating, Session, Summary } from '@/types';

// メイン画面の中身。何も選んでいない・新しいセッション・既存のセッションの3つを出し分ける
export function SessionView() {
    const hasProjects = useAppStore((s) => visibleProjects(s).length > 0);
    const project = useAppStore(currentProject);
    const session = useAppStore(currentSession);
    const recordingState = useAppStore((s) => s.recordingState);
    const server = useAppStore((s) => s.server);
    const liveIntervalMin = useAppStore((s) => s.settings.ollama.liveSummaryIntervalMin);
    const finalModel = useAppStore((s) => s.settings.ollama.finalSummaryModel);
    const generating = useAppStore((s) => s.generating);
    const partial = useAppStore((s) => s.partial);
    const liveDraft = useAppStore((s) => s.liveDraft);
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    const { tab, changeTab, followTranscript } = useTabScroll(session?.id);
    const audio = useRef<HTMLAudioElement>(null);

    if (!project) {
        return <EmptyState hasProjects={hasProjects} />;
    }

    const live = summaryStatus(recordingState, server, liveIntervalMin);
    // 録音を終えていて、録音ファイルが残っているセッションだけ再生できる（消えた・変換前なら出さない）
    const recordingUrl =
        session && session.status !== 'recording' && session.files?.recording
            ? `/api/projects/${project.id}/sessions/${session.id}/recording`
            : null;
    const seek = (time: string) => {
        const sec = clockToSeconds(time);
        const player = audio.current;
        if (sec === null || !player) {
            return;
        }
        player.currentTime = sec;
        void player.play();
    };

    return (
        <Tabs value={tab} onValueChange={changeTab}>
            {/* 上のバーのすぐ下に貼り付ける（#78）。左右の余白まで背景を塗って、本文が透けないようにする */}
            {/* 再生バーも一緒に貼り付ける（文字起こしの下の方で時刻を押しても、止められるように） */}
            <div className='sticky top-(--top-bar-height,0px) z-10 -mx-4 flex flex-col items-center gap-2 bg-background px-4 pb-2'>
                <TabsList>
                    <TabsTrigger value='transcript'>文字起こし</TabsTrigger>
                    <TabsTrigger value='summary'>要約</TabsTrigger>
                </TabsList>
                {recordingUrl && <RecordingPlayer src={recordingUrl} audio={audio} />}
            </div>
            {/* 下の pb は、マイクのボタンの上に出す経過時間（絶対配置）が本文に重ならないようにするため */}
            <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-16'>
                {session ? (
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
                                (session.id === recordingSessionId ? '・録音中' : '・ほかの端末で録音中')}
                            {session.status === 'interrupted' && '・途中で中断'}
                        </p>
                    </div>
                ) : (
                    <div>
                        <h1 className='text-lg font-semibold'>新しいセッション</h1>
                        <p className='text-xs text-muted-foreground'>
                            {project.name}（{project.path}）に録音します
                        </p>
                    </div>
                )}

                <TabsContent value='transcript' className='flex flex-col gap-2'>
                    {session && !session.loaded && <p className='text-sm text-muted-foreground'>読み込んでいます…</p>}
                    {session && expired(session, 'transcript') && (
                        <p className='text-sm text-muted-foreground'>
                            文字起こしは、保存期間を過ぎたため消えています（期限切れ）。
                        </p>
                    )}
                    {session && (
                        <Transcript
                            sessionId={session.id}
                            lines={session.transcript}
                            partial={partial?.sessionId === session.id ? partial : null}
                            follow={followTranscript}
                            onSeek={recordingUrl ? seek : undefined}
                        />
                    )}
                    {!session && recordingState === 'idle' && (
                        <p className='text-sm text-muted-foreground'>マイクボタンを押すと録音が始まります。</p>
                    )}
                    <StatusIndicator status={transcriptStatus(recordingState, server, recordingSessionId)} />
                </TabsContent>

                <TabsContent value='summary' className='flex flex-col gap-4'>
                    {session ? (
                        <SummaryPanel
                            session={session}
                            finalModel={finalModel}
                            generating={generating}
                            liveDraft={liveDraft}
                        />
                    ) : (
                        recordingState === 'idle' && (
                            <p className='text-sm text-muted-foreground'>
                                録音が始まると、{liveIntervalMin} 分おきに途中の要約がここに出ます。
                            </p>
                        )
                    )}
                    {live && <StatusIndicator status={live} />}
                </TabsContent>
            </div>
        </Tabs>
    );
}

type Tab = 'transcript' | 'summary';

type TabScroll = { top: number; atBottom: boolean };

// タブごとのスクロール位置を覚えておき、切り替えたら戻す（#78）。ページ全体がスクロールするので window の位置を使う
// 一番下にいたタブは、離れている間に伸びていても一番下に戻す（録音中の文字起こしを追い続けるため）
// セッションを替えたら覚えた位置は捨てる（タブはそのまま）
function useTabScroll(sessionId: string | undefined) {
    const [state, setState] = useState<{
        tab: Tab;
        sessionId: string | undefined;
        saved: Partial<Record<Tab, TabScroll>>;
    }>({ tab: 'transcript', sessionId, saved: {} });
    const restore = useRef<TabScroll | null>(null);

    const changeTab = (value: string) => {
        const next = value as Tab;
        const saved = {
            ...(state.sessionId === sessionId ? state.saved : {}),
            [state.tab]: { top: window.scrollY, atBottom: isScrolledToBottom() },
        };
        restore.current = saved[next] ?? { top: 0, atBottom: false };
        setState({ tab: next, sessionId, saved });
    };

    // 描き替えた後、画面に出る前に戻す
    useLayoutEffect(() => {
        if (restore.current !== null) {
            if (restore.current.atBottom) {
                scrollToBottom();
            } else {
                window.scrollTo({ top: restore.current.top });
            }
            restore.current = null;
        }
    }, [state.tab]);

    const transcript = state.sessionId === sessionId ? state.saved.transcript : undefined;
    // 文字起こしを出し直したとき、下を追うかどうか。初めて出すときは追う
    const followTranscript = transcript?.atBottom ?? true;
    return { tab: state.tab, changeTab, followTranscript };
}

// 最終の要約。既定は、今選んでいるモデルの要約のうちいちばん新しいもの。なければモデルを問わずいちばん新しいもの。
// 世代が複数あれば切り替えられる（spec 6.5）
function SummaryPanel({
    session,
    finalModel,
    generating,
    liveDraft,
}: {
    session: Session;
    finalModel: string;
    generating: Generating | null;
    liveDraft: { sessionId: string; text: string } | null;
}) {
    const regenerate = useAppStore((s) => s.regenerateSummary);
    const ollama = useAppStore((s) => s.server.ollama);
    // 手で選んだ世代。セッションを替えたときと、要約が増えた（作り直した）ときは既定に戻す
    const [picked, setPicked] = useState<{ sessionId: string; count: number; generationId: string } | null>(null);

    const fallback: Summary | undefined =
        session.summaries.findLast((s) => s.model === finalModel) ?? session.summaries.at(-1);
    const summary =
        picked?.sessionId === session.id && picked.count === session.summaries.length
            ? (session.summaries.find((s) => s.generationId === picked.generationId) ?? fallback)
            : fallback;

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
        // 本文が届き始めるまで（モデルの読み込み・思考・長い録音の部分ごとの要約の間）は、空にせず
        // 作り直しなら今表示している要約を、録音を終えた直後なら途中の要約を出しておく（#80）
        // 途中の要約は最終の要約ができた後も手元に残ることがあるので、最終の要約を先に見る
        const live = liveDraft?.sessionId === session.id ? liveDraft.text : session.liveSummary;
        const placeholder = summary?.text
            ? { label: '今の要約（作り直した要約が届いたら差し替えます）', text: summary.text }
            : live
              ? { label: '途中の要約（最終の要約が届いたら差し替えます）', text: live }
              : null;
        return (
            <>
                {status}
                {placeholder && (
                    <>
                        <p className='text-xs text-muted-foreground'>{placeholder.label}</p>
                        <Markdown>{placeholder.text}</Markdown>
                    </>
                )}
            </>
        );
    }
    // 作り直せるのは、録音を終えていて文字起こしが残っているセッション
    // ほかのセッションの要約を作っている間は押せない（作成中の表示は1つだけ持つので、二重に頼まないように）
    const canRegenerate =
        session.status !== 'recording' &&
        session.loaded === true &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        generating === null;
    const regenerateButton = canRegenerate && (
        <Button variant='outline' size='sm' onClick={() => void regenerate(session.id)}>
            <RefreshCwIcon />
            {finalModel} で{summary ? '作り直す' : '要約を作る'}
        </Button>
    );

    // 最終の要約を作れなかったこと（spec 6.7）。Ollama が戻っていれば、作り直しを勧める
    const failure = session.summaryFailed && session.status !== 'recording' && (
        <div
            role='alert'
            className='flex flex-col items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm'
        >
            <p className='flex items-center gap-1.5 font-medium text-destructive'>
                <TriangleAlertIcon className='size-4' />
                {summary ? '直近の要約の作り直しに失敗しました' : '最終の要約を作れませんでした'}
            </p>
            <p className='text-xs text-muted-foreground'>
                {!canRegenerate
                    ? session.files?.transcript === false || session.transcript.length === 0
                        ? '文字起こしが残っていないため、作り直せません。'
                        : 'ほかの要約を作り終えてから、作り直してください。'
                    : ollama === 'ready'
                      ? 'Ollama には今つながっています。作り直してください（保存に失敗した場合は、ディスクの空きも確かめてください）。'
                      : 'Ollama に接続できません。Ollama が動いているか確かめてから、作り直してください。'}
            </p>
            {regenerateButton}
        </div>
    );

    if (!summary) {
        // 最終の要約がまだないときは、途中の要約を代わりに出す（届いている途中なら、それを少しずつ）
        const live = liveDraft?.sessionId === session.id ? liveDraft.text : session.liveSummary;
        if (live) {
            return (
                <>
                    {failure}
                    <p className='text-xs text-muted-foreground'>
                        途中の要約{session.status === 'recording' ? '（録音中に数分おきに更新します）' : ''}
                    </p>
                    <Markdown streaming={liveDraft?.sessionId === session.id}>{live}</Markdown>
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
                    {expired(session, 'summary')
                        ? '要約は、保存期間を過ぎたため消えています（期限切れ）。'
                        : 'まだ要約がありません。'}
                </p>
                {regenerateButton}
            </div>
        );
    }

    const label = (s: Summary) => `${s.model} で生成・${s.generatedAt}`;
    return (
        <>
            {failure}
            <div className='flex flex-wrap items-center gap-2'>
                {session.summaries.length > 1 ? (
                    <Select
                        value={summary.generationId}
                        onValueChange={(generationId) =>
                            setPicked({ sessionId: session.id, count: session.summaries.length, generationId })
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
                {regenerateButton}
            </div>
            {summary.model !== finalModel && (
                <p className='text-xs text-muted-foreground'>{finalModel} の要約はまだありません。</p>
            )}
            <Markdown>{summary.text ?? ''}</Markdown>
        </>
    );
}

// 保存期間を過ぎて、ファイルが消えているか（spec 6.8）。サーバーから取ったセッションだけ判定できる
// 要約は「まだ作っていない」と区別できないので、文字起こしも消えているときだけ期限切れとみなす
function expired(session: Session, what: 'transcript' | 'summary') {
    const files = session.files;
    if (!files || !session.loaded || session.status === 'recording') {
        return false;
    }
    if (what === 'transcript') {
        return !files.transcript;
    }
    return !files.transcript && files.summaries === 0 && !files.liveSummary;
}

// 何も選んでいないとき
function EmptyState({ hasProjects }: { hasProjects: boolean }) {
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            {hasProjects ? <AudioLinesIcon className='size-10' /> : <FolderPlusIcon className='size-10' />}
            <p className='text-lg font-semibold text-foreground'>
                {hasProjects ? 'セッションを開くか、新しく録音しましょう' : 'まずはプロジェクトを作りましょう'}
            </p>
            <p className='max-w-md text-sm'>
                {hasProjects
                    ? 'メニューから過去のセッションを開くか、プロジェクトの ＋ から新しいセッションを作れます。'
                    : 'メニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください。'}
            </p>
        </div>
    );
}
