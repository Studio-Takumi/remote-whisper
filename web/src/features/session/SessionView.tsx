import { useCallback, useMemo, useRef, useState } from 'react';

import { isDemoBuild } from '@/api/demoBuild';
import { apiUrl } from '@/api/endpoint';
import { makingFinalTranscript, summaryStatus, transcriptStatus } from '@/api/status';
import { useCurrentProject, useCurrentSession, useProjects } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { describeMaterialRange } from '@/features/materials/materialRange';
import { MicAlert } from '@/features/recording/MicAlert';
import { recordedElsewhere } from '@/features/recording/watch';
import { EmptyState } from '@/features/session/EmptyState';
import { FinalTranscriptBar } from '@/features/session/FinalTranscriptBar';
import { NewSessionHeader } from '@/features/session/NewSessionHeader';
import { NotFoundState } from '@/features/session/NotFoundState';
import { PlaybackSourceSelect, RecordingPlayer } from '@/features/session/RecordingPlayer';
import { SessionHeader } from '@/features/session/SessionHeader';
import { SessionTerms } from '@/features/session/SessionTerms';
import { ShareButton } from '@/features/session/ShareButton';
import { SourceList } from '@/features/session/SourceList';
import { StatusIndicator } from '@/features/session/StatusIndicator';
import { SummaryPanel } from '@/features/session/SummaryPanel';
import { Transcript } from '@/features/session/Transcript';
import { TranscriptCorrection } from '@/features/session/TranscriptCorrection';
import { type LivePartial, partialsOf } from '@/features/session/livePartials';
import { type SessionPlayback, lineAt, nextPlayback } from '@/features/session/playbackLine';
import { expired, shareSource } from '@/features/session/sessionContent';
import { sourceNames } from '@/features/session/sources';
import { type PickedSummary, shownSummary } from '@/features/session/summaryPick';
import { usePlaybackSource } from '@/features/session/usePlaybackSource';
import { useSessionSources } from '@/features/session/useSessionSources';
import { useTabScroll } from '@/features/session/useTabScroll';
import { llmBackend, llmModels } from '@/features/settings/settings';
import { clockToSeconds } from '@/lib/time';

const NO_PARTIALS: LivePartial[] = [];

// デモ版（#414）は、文字起こしと要約の本文を選べなくする（コピー対策。技術的には回避できる）
const demoNoSelect = isDemoBuild ? 'select-none [-webkit-touch-callout:none]' : '';

// メイン画面の中身。何も選んでいない・新しいセッション・既存のセッションの3つを出し分ける
export function SessionView() {
    const hasProjects = useProjects().length > 0;
    const notFound = useAppStore((s) => s.notFound);
    const project = useCurrentProject();
    const session = useCurrentSession();
    const showPickedTerms = useAppStore((s) => s.settings.display.showPickedTerms ?? false);
    const recordingState = useAppStore((s) => s.recordingState);
    const server = useAppStore((s) => s.server);
    const liveIntervalMin = useAppStore((s) => s.settings.ollama.liveSummaryIntervalMin);
    // 選んでいる LLM（Ollama か LM Studio。#327）の処理ごとのモデル
    const backend = useAppStore((s) => llmBackend(s.settings));
    const models = useAppStore((s) => llmModels(s.settings));
    const generating = useAppStore((s) => s.generating);
    const allPartials = useAppStore((s) => s.partials);
    const partials = useMemo(() => (session ? partialsOf(allPartials, session.id) : []), [allPartials, session]);
    const liveDraft = useAppStore((s) => s.liveDraft);
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    // 音源の一覧と、行の札に出す名前（音源が 2 つ以上のセッションだけ。#357）
    const sources = useSessionSources(session);
    const names = useMemo(() => sourceNames(sources), [sources]);
    const { tab, changeTab, followTranscript } = useTabScroll(session?.id);
    const audio = useRef<HTMLAudioElement>(null);
    // 再生する音源（#371。音源が 1 つのセッションは主の音源だけ）
    const playSource = usePlaybackSource(session, audio);
    // 要約パネルで手で選んだ世代（文字起こしタブの共有にも使う）
    const [pickedSummary, setPickedSummary] = useState<PickedSummary | null>(null);
    // 読み込めなかった録音（開いた後に消えたなど）。再生バーを消し、時刻も押せなくする
    const [failedRecording, setFailedRecording] = useState<string | null>(null);
    // 録音の再生位置に当たる行（#122）。行が変わったときだけ変える（再生中の timeupdate のたびに描き直さない）
    const [playback, setPlayback] = useState<SessionPlayback | null>(null);
    // 文字起こしの本文（文字を選んで置き換える範囲。#176）
    const transcriptBox = useRef<HTMLDivElement>(null);
    // 最終の文字起こし（#121）があれば、それだけを出す（要約と同じ。録音中の文字起こしには戻せない。#145）。
    // なければ（録音中・作っている途中・作らない設定・作れなかった）、録音中の文字起こしを出す
    const final = session?.finalTranscript;
    const lines = final ? final.lines : session?.transcript;
    const starts = useMemo(() => (lines ?? []).map((l) => clockToSeconds(l.time) ?? 0), [lines]);
    // 行の時刻（主の音源の時刻）から、選んでいる音源で再生する（#371）
    const seekSource = playSource.seek;
    const seek = useCallback(
        (time: string) => {
            const sec = clockToSeconds(time);
            if (sec !== null) {
                seekSource(sec);
            }
        },
        [seekSource],
    );

    if (!project) {
        return notFound ? <NotFoundState /> : <EmptyState hasProjects={hasProjects} />;
    }

    // 録音中に別のセッションを開いていても、文字起こしなどはそのセッションに届き続ける（#133）。
    // 録音の状態（文字起こし中・途中の要約）は、録音中のセッションの画面でだけ出す
    const viewingRecording = session !== undefined && session.id === recordingSessionId;
    const viewState = viewingRecording ? recordingState : 'idle';
    const recordingElsewhere = recordingState !== 'idle' && !viewingRecording;
    const live = summaryStatus(viewState, server, liveIntervalMin, backend);
    // 録音を終えていて、録音ファイルが残っているセッションだけ再生できる（消えた・変換前なら出さない）
    const url =
        session && session.status !== 'recording' && session.files?.recording
            ? apiUrl(`/api/projects/${project.id}/sessions/${session.id}/recording${playSource.query}`)
            : null;
    const recordingUrl = url !== failedRecording ? url : null;
    const onTime = (sec: number, playing: boolean, seeked: boolean) => {
        if (!session) {
            return;
        }
        if (playing && playSource.notice) {
            playSource.clearNotice();
        }
        const index = lineAt(starts, playSource.mainTime(sec));
        setPlayback((p) => nextPlayback(p, session.id, index, playing, seeked));
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
                        onError={() => {
                            // ほかの音源が読み込めなければ主の音源に戻す。主の音源なら再生バーを消す
                            if (!playSource.failed()) {
                                setFailedRecording(recordingUrl);
                            }
                        }}
                        onTime={onTime}
                        onLoaded={playSource.onLoaded}
                    >
                        {playSource.playable.length >= 2 && (
                            <PlaybackSourceSelect
                                sources={playSource.playable}
                                value={playSource.selected}
                                onChange={playSource.select}
                                uploaded={session?.uploaded === true}
                            />
                        )}
                    </RecordingPlayer>
                )}
                {recordingUrl && playSource.notice && (
                    <p role='status' className='w-full max-w-3xl text-xs text-muted-foreground'>
                        {playSource.notice}
                    </p>
                )}
            </div>
            {/* 下の pb は、マイクのボタンの上に出す経過時間（絶対配置）が本文に重ならないようにするため */}
            <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 pt-2 pb-16'>
                {session ? <SessionHeader session={session} /> : <NewSessionHeader project={project} />}

                <TabsContent value='transcript' className='flex flex-col gap-2'>
                    {session && !expired(session, 'transcript') && (
                        <SessionTerms session={session} showPicked={showPickedTerms} />
                    )}
                    {session?.materialRange && session.materialRange.length > 0 && (
                        <p className='text-xs text-muted-foreground'>{describeMaterialRange(session.materialRange)}</p>
                    )}
                    {session && !session.loaded && <p className='text-sm text-muted-foreground'>読み込んでいます…</p>}
                    {session && expired(session, 'transcript') && (
                        <p className='text-sm text-muted-foreground'>文字起こしは期限切れのため消えています</p>
                    )}
                    {session && ((session.loaded && lines && lines.length > 0) || sources.length >= 2) && (
                        <div className='flex flex-wrap gap-2'>
                            {session.loaded && lines && lines.length > 0 && (
                                <ShareButton
                                    source={shareSource(
                                        session,
                                        shownSummary(session, models, pickedSummary)?.text,
                                        lines,
                                    )}
                                    initial='transcript'
                                />
                            )}
                            <SourceList session={session} sources={sources} />
                        </div>
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
                        <div ref={transcriptBox} className={demoNoSelect}>
                            <Transcript
                                sessionId={session.id}
                                lines={lines ?? []}
                                partials={final ? NO_PARTIALS : partials}
                                follow={followTranscript}
                                onSeek={recordingUrl ? seek : undefined}
                                playback={recordingUrl && playback?.sessionId === session.id ? playback : null}
                                sourceNames={names}
                                defaultSource={sources.length >= 2 ? 1 : undefined}
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
                        <p className='text-sm text-muted-foreground'>マイクボタンを押すと録音が始まります</p>
                    )}
                    {!session && recordingElsewhere && (
                        <p className='text-sm text-muted-foreground'>
                            ほかのセッションで録音中です。終えると、ここから録音できます
                        </p>
                    )}
                    {/* ほかの端末で録音中のセッションを見ている間は、この端末の状態（待機中）を出さない（#238）。
                        デモ版（#414）は録音しないので出さない */}
                    {!isDemoBuild && !recordedElsewhere(session, recordingSessionId) && (
                        <StatusIndicator status={transcriptStatus(viewState, server, recordingSessionId)} />
                    )}
                </TabsContent>

                <TabsContent value='summary' className={`flex flex-col gap-4 ${demoNoSelect}`}>
                    {session ? (
                        <SummaryPanel
                            session={session}
                            models={models}
                            generating={generating}
                            liveDraft={liveDraft}
                            picked={pickedSummary}
                            onPick={setPickedSummary}
                        />
                    ) : (
                        recordingState === 'idle' && (
                            <p className='text-sm text-muted-foreground'>
                                録音が始まると、{liveIntervalMin} 分おきにリアルタイム要約がここに出ます
                            </p>
                        )
                    )}
                    {live && <StatusIndicator status={live} />}
                </TabsContent>
            </div>
        </Tabs>
    );
}
