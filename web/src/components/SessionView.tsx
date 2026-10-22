import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
    AudioLinesIcon,
    CopyIcon,
    FileAudioIcon,
    FolderPlusIcon,
    MicIcon,
    RefreshCwIcon,
    SearchXIcon,
    TriangleAlertIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { AudioDropZone, AudioUploadButton, UploadProgress } from '@/components/AudioUpload';
import { LiveSummary } from '@/components/LiveSummary';
import { Markdown } from '@/components/Markdown';
import { MicAlert } from '@/components/MicAlert';
import { RecordingPlayer } from '@/components/RecordingPlayer';
import { SessionTerms } from '@/components/SessionTerms';
import { StatusIndicator } from '@/components/StatusIndicator';
import { type Playback, Transcript } from '@/components/Transcript';
import { TranscriptCorrection } from '@/components/TranscriptCorrection';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { copyText } from '@/copyMarkdown';
import { pickFinalTranscript } from '@/data';
import { apiUrl } from '@/endpoint';
import { describeMaterialRange } from '@/materialRange';
import { recordingLocks } from '@/recording';
import { isScrolledToBottom, scrollToBottom } from '@/scroll';
import { type OllamaModels, finalModelLabel, isCurrentFinalSummary } from '@/settings';
import { makingFinalTranscript, summaryStatus, transcriptStatus } from '@/status';
import { currentProject, currentSession, useAppStore, visibleProjects } from '@/store';
import { clockToSeconds } from '@/time';
import type { FinalTranscriptInfo, Generating, Session, Summary } from '@/types';
import { describeWatched, recordedElsewhere } from '@/watch';

// メイン画面の中身。何も選んでいない・新しいセッション・既存のセッションの3つを出し分ける
export function SessionView() {
    const hasProjects = useAppStore((s) => visibleProjects(s).length > 0);
    const notFound = useAppStore((s) => s.notFound);
    const project = useAppStore(currentProject);
    const session = useAppStore(currentSession);
    const showPickedTerms = useAppStore((s) => s.settings.display.showPickedTerms ?? false);
    const recordingState = useAppStore((s) => s.recordingState);
    const server = useAppStore((s) => s.server);
    const liveIntervalMin = useAppStore((s) => s.settings.ollama.liveSummaryIntervalMin);
    const models = useAppStore((s) => s.settings.ollama.models);
    const generating = useAppStore((s) => s.generating);
    const partial = useAppStore((s) => s.partial);
    const liveDraft = useAppStore((s) => s.liveDraft);
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    // ほかの端末で録音中のセッションを見ている（#238）
    const watching = useAppStore((s) => s.watching);
    const continueRecording = useAppStore((s) => s.continueRecording);
    const { tab, changeTab, followTranscript } = useTabScroll(session?.id);
    const audio = useRef<HTMLAudioElement>(null);
    // 読み込めなかった録音（開いた後に消えたなど）。再生バーを消し、時刻も押せなくする
    const [failedRecording, setFailedRecording] = useState<string | null>(null);
    // 録音の再生位置に当たる行（#122）。行が変わったときだけ変える（再生中の timeupdate のたびに描き直さない）
    const [playback, setPlayback] = useState<(Playback & { sessionId: string }) | null>(null);
    // 文字起こしの本文（文字を選んで置き換える範囲。#176）
    const transcriptBox = useRef<HTMLDivElement>(null);
    // 最終の文字起こし（#121）があれば、それだけを出す（要約と同じ。録音中の文字起こしには戻せない。#145）。
    // なければ（録音中・作っている途中・作らない設定・作れなかった）、録音中の文字起こしを出す
    const final = session?.finalTranscript;
    const lines = final ? final.lines : session?.transcript;
    const starts = useMemo(() => (lines ?? []).map((l) => clockToSeconds(l.time) ?? 0), [lines]);
    const seek = useCallback((time: string) => {
        const sec = clockToSeconds(time);
        const player = audio.current;
        if (sec === null || !player) {
            return;
        }
        player.currentTime = sec;
        // 読み込めないときなどは、onError で再生バーを消す
        player.play().catch(() => {});
    }, []);

    if (!project) {
        return notFound ? <NotFoundState /> : <EmptyState hasProjects={hasProjects} />;
    }

    // 録音中に別のセッションを開いていても、文字起こしなどはそのセッションに届き続ける（#133）。
    // 録音の状態（文字起こし中・途中の要約）は、録音中のセッションの画面でだけ出す
    const viewingRecording = session !== undefined && session.id === recordingSessionId;
    const viewState = viewingRecording ? recordingState : 'idle';
    const recordingElsewhere = recordingState !== 'idle' && !viewingRecording;
    const live = summaryStatus(viewState, server, liveIntervalMin);
    // 録音を終えていて、録音ファイルが残っているセッションだけ再生できる（消えた・変換前なら出さない）
    const url =
        session && session.status !== 'recording' && session.files?.recording
            ? apiUrl(`/api/projects/${project.id}/sessions/${session.id}/recording`)
            : null;
    const recordingUrl = url !== failedRecording ? url : null;
    const onTime = (sec: number, playing: boolean, seeked: boolean) => {
        if (!session) {
            return;
        }
        const index = lineAt(starts, sec);
        setPlayback((p) => {
            const same = p?.sessionId === session.id;
            if (same && p.index === index && p.playing === playing && !seeked) {
                return p;
            }
            const seeks = (same ? p.seeks : 0) + (seeked ? 1 : 0);
            return { sessionId: session.id, index, playing, seeks };
        });
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
                <MicAlert />
                {recordingUrl && (
                    <RecordingPlayer
                        src={recordingUrl}
                        audio={audio}
                        onError={() => setFailedRecording(recordingUrl)}
                        onTime={onTime}
                    />
                )}
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
                                (session.id === recordingSessionId
                                    ? '・録音中'
                                    : `・${describeWatched(watching?.sessionId === session.id ? watching.state : undefined)}（この端末では閲覧専用です）`)}
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
                ) : (
                    // 録音のほかに、音声ファイル（選ぶ・ドロップする）からも作れる（#180）
                    <AudioDropZone projectId={project.id}>
                        <div className='flex flex-col gap-2'>
                            <div>
                                <h1 className='text-lg font-semibold'>新しいセッション</h1>
                                <p className='text-xs text-muted-foreground'>
                                    {project.name}（{project.path}）に録音します
                                </p>
                            </div>
                            <div className='flex flex-wrap items-center gap-2'>
                                <AudioUploadButton projectId={project.id} />
                                <p className='text-xs text-muted-foreground'>
                                    音声ファイル（wav・mp3・m4a など）をドロップしても作れます
                                </p>
                            </div>
                            <UploadProgress />
                        </div>
                    </AudioDropZone>
                )}

                <TabsContent value='transcript' className='flex flex-col gap-2'>
                    {session && !expired(session, 'transcript') && (
                        <SessionTerms session={session} showPicked={showPickedTerms} />
                    )}
                    {session?.materialRange && session.materialRange.length > 0 && (
                        <p className='text-xs text-muted-foreground'>{describeMaterialRange(session.materialRange)}</p>
                    )}
                    {session && !session.loaded && <p className='text-sm text-muted-foreground'>読み込んでいます…</p>}
                    {session && expired(session, 'transcript') && (
                        <p className='text-sm text-muted-foreground'>文字起こしは期限切れのため消えています。</p>
                    )}
                    {session && (
                        <FinalTranscriptBar
                            session={session}
                            making={
                                server.transcribing.includes(session.id) ||
                                makingFinalTranscript(server.jobs, session.id)
                            }
                        />
                    )}
                    {session && (
                        <div ref={transcriptBox}>
                            <Transcript
                                sessionId={session.id}
                                lines={lines ?? []}
                                partial={!final && partial?.sessionId === session.id ? partial : null}
                                follow={followTranscript}
                                onSeek={recordingUrl ? seek : undefined}
                                playback={recordingUrl && playback?.sessionId === session.id ? playback : null}
                            />
                            <TranscriptCorrection
                                container={transcriptBox}
                                sessionId={session.id}
                                lines={lines ?? []}
                                target={
                                    final
                                        ? { transcript: 'final', generation: final.generationId }
                                        : { transcript: 'live' }
                                }
                            />
                        </div>
                    )}
                    {!session && recordingState === 'idle' && (
                        <p className='text-sm text-muted-foreground'>マイクボタンを押すと録音が始まります。</p>
                    )}
                    {!session && recordingElsewhere && (
                        <p className='text-sm text-muted-foreground'>
                            ほかのセッションで録音中です。終えると、ここから録音できます。
                        </p>
                    )}
                    {/* ほかの端末で録音中のセッションを見ている間は、この端末の状態（待機中）を出さない（#238） */}
                    {!recordedElsewhere(session, recordingSessionId) && (
                        <StatusIndicator status={transcriptStatus(viewState, server, recordingSessionId)} />
                    )}
                </TabsContent>

                <TabsContent value='summary' className='flex flex-col gap-4'>
                    {session ? (
                        <SummaryPanel session={session} models={models} generating={generating} liveDraft={liveDraft} />
                    ) : (
                        recordingState === 'idle' && (
                            <p className='text-sm text-muted-foreground'>
                                録音が始まると、{liveIntervalMin} 分おきにリアルタイム要約がここに出ます。
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

// 最終の文字起こし（#121）の世代の切り替えと作り直し。作っている途中なら、そう出す
function FinalTranscriptBar({ session, making }: { session: Session; making: boolean }) {
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

    // 作り直せるのは、録音を終えていて録音ファイルが残っているセッション（作っている間は押せない）。#124
    const done = session.status !== 'recording' && session.loaded === true;
    const regenerateButton = available && done && session.files?.recording && !making && (
        <Button
            variant='outline'
            size='sm'
            className='h-7'
            disabled={recording}
            title={recording ? recordingLocks.regenerate : undefined}
            onClick={() => void regenerate(session.id)}
        >
            <RefreshCwIcon />
            {whisperModel} で{final ? '再生成する' : '浄書する'}
        </Button>
    );
    const locked = regenerateButton && recording && (
        <p className='text-xs text-muted-foreground'>{recordingLocks.regenerate}</p>
    );
    const status = making && (
        <StatusIndicator
            status={{
                tone: 'active',
                text: final ? '浄書済み文字起こしを再生成しています…' : '浄書中…',
            }}
        />
    );
    const noRecording = available && done && session.files?.recording === false && (
        <p className='text-xs text-muted-foreground'>録音ファイルがないため、再生成できません。</p>
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
    const label = (g: FinalTranscriptInfo) =>
        [g.model, showSpeakers && g.diarization === 'done' ? `話者 ${g.speakers} 人` : null, g.generatedAt]
            .filter(Boolean)
            .join('・');
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
                        <SelectTrigger size='sm' className='text-xs' aria-label='表示する浄書済み文字起こし'>
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
                    <span className='text-xs text-muted-foreground'>{`浄書済み文字起こし（${label(final)}）`}</span>
                )}
                {regenerateButton}
            </div>
            {final.model !== whisperModel && (
                <p className='text-xs text-muted-foreground'>{whisperModel} の浄書済み文字起こしはまだありません。</p>
            )}
            {final.diarization === 'unavailable' && (
                <p className='text-xs text-muted-foreground'>
                    話者分けはできませんでした（HuggingFace のトークンまたはモデルの利用条件への同意がありません）
                </p>
            )}
            {noRecording}
            {locked}
            {status}
        </div>
    );
}

// 最終の要約。既定は、今選んでいるモデルの要約のうちいちばん新しいもの。なければモデルを問わずいちばん新しいもの。
// 世代が複数あれば切り替えられる（spec/flows.md 6.5）
function SummaryPanel({
    session,
    models,
    generating,
    liveDraft,
}: {
    session: Session;
    // 今の全体設定の処理ごとのモデル（最終の要約は、全体概要と要約詳細の組で見る。#178）
    models: OllamaModels;
    generating: Generating | null;
    liveDraft: { sessionId: string; text: string } | null;
}) {
    const regenerate = useAppStore((s) => s.regenerateSummary);
    const ollama = useAppStore((s) => s.server.ollama);
    // 録音中は作り直せない（GPU を長く使い、録音中の文字起こしが止まるため。#133）
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    // 手で選んだ世代。セッションを替えたときと、要約が増えた（作り直した）ときは既定に戻す
    const [picked, setPicked] = useState<{ sessionId: string; count: number; generationId: string } | null>(null);

    const finalModel = finalModelLabel(models);
    const fallback: Summary | undefined =
        session.summaries.findLast((s) => isCurrentFinalSummary(s, models)) ?? session.summaries.at(-1);
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
            ? { label: '今の要約（再生成した要約が届き次第差し替えます）', text: summary.text, live: false }
            : live
              ? { label: 'リアルタイム要約（最終要約が届き次第差し替えます）', text: live, live: true }
              : null;
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
    // 作り直せるのは、録音を終えていて文字起こしが残っているセッション
    // ほかのセッションの要約を作っている間は押せない（作成中の表示は1つだけ持つので、二重に頼まないように）
    const canRegenerate =
        session.status !== 'recording' &&
        session.loaded === true &&
        session.files?.transcript !== false &&
        session.transcript.length > 0 &&
        generating === null;
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
                {!canRegenerate
                    ? session.files?.transcript === false || session.transcript.length === 0
                        ? '文字起こしが残っていないため、再生成できません。'
                        : 'ほかの要約を作り終えてから、再生成してください。'
                    : ollama === 'ready'
                      ? 'Ollama には今つながっています。再生成してください（保存に失敗した場合は、ディスクの空きも確かめてください）。'
                      : 'Ollama に接続できません。動いているか確かめてから再生成してください。'}
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
                    {expired(session, 'summary') ? '要約は期限切れのためありません。' : 'まだ要約がありません。'}
                </p>
                {regenerateButton}
            </div>
        );
    }

    // 全体概要のモデルが要約詳細と違えば、両方出す（#178）
    const label = (s: Summary) =>
        `${finalModelLabel({ ...models, overview: s.overviewModel ?? s.model, detail: s.model })} で生成・${s.generatedAt}`;
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
                {summary.text && (
                    <Button
                        variant='outline'
                        size='sm'
                        title='要約を Markdown のままコピーします'
                        onClick={() =>
                            copyText(summary.text ?? '').then(
                                () => toast.success('要約をコピーしました'),
                                () => toast.error('要約をコピーできませんでした'),
                            )
                        }
                    >
                        <CopyIcon />
                        コピー
                    </Button>
                )}
                {regenerateButton}
            </div>
            {!isCurrentFinalSummary(summary, models) && (
                <p className='text-xs text-muted-foreground'>{finalModel} の要約はまだありません。</p>
            )}
            <Markdown>{summary.text ?? ''}</Markdown>
        </>
    );
}

// 再生位置（秒）に当たる行。行の始まり（starts は時刻の順）が再生位置以前の、最後の行。まだなければ null
function lineAt(starts: number[], sec: number) {
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] <= sec) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return lo > 0 ? lo - 1 : null;
}

// 保存期間を過ぎて、ファイルが消えているか（spec/flows.md 6.8）。サーバーから取ったセッションだけ判定できる
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

// URL のセッション・プロジェクトがないとき（#177）
function NotFoundState() {
    return (
        <div className='flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground'>
            <SearchXIcon className='size-10' />
            <p className='text-lg font-semibold text-foreground'>見つかりません</p>
            <p className='max-w-md text-sm'>このセッションまたはプロジェクトは、消えたか期限切れです。</p>
        </div>
    );
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
                    ? 'メニューからセッションを開くか、プロジェクトの ＋ で新しく作れます。'
                    : 'メニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください。'}
            </p>
        </div>
    );
}
