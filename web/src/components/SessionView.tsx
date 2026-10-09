import { AudioLinesIcon, FolderPlusIcon } from 'lucide-react';

import { Markdown } from '@/components/Markdown';
import { StatusIndicator } from '@/components/StatusIndicator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Generating, Session, Summary } from '@/mock';
import { summaryStatus, transcriptStatus } from '@/status';
import { currentProject, currentSession, useAppStore, visibleProjects } from '@/store';

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

    if (!project) {
        return <EmptyState hasProjects={hasProjects} />;
    }

    const live = summaryStatus(recordingState, server, liveIntervalMin);

    return (
        <Tabs defaultValue='transcript'>
            <div className='flex justify-center'>
                <TabsList>
                    <TabsTrigger value='transcript'>文字起こし</TabsTrigger>
                    <TabsTrigger value='summary'>要約</TabsTrigger>
                </TabsList>
            </div>
            <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 pt-4'>
                {session ? (
                    <div>
                        <h1 className='text-lg font-semibold'>{session.title}</h1>
                        <p className='text-xs text-muted-foreground'>
                            {session.startedAt}
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
                    {session?.transcript.map((line) => (
                        <div key={line.time} className='flex gap-3'>
                            <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>
                                {line.time}
                            </span>
                            <p className='leading-6'>{line.text}</p>
                        </div>
                    ))}
                    {!session && recordingState === 'idle' && (
                        <p className='text-sm text-muted-foreground'>マイクボタンを押すと録音が始まります。</p>
                    )}
                    <StatusIndicator status={transcriptStatus(recordingState, server)} />
                </TabsContent>

                <TabsContent value='summary' className='flex flex-col gap-4'>
                    {session ? (
                        <SummaryPanel session={session} finalModel={finalModel} generating={generating} />
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

// 最終の要約。今選んでいるモデルの要約があればそれを、なければいちばん新しいものを出す
function SummaryPanel({
    session,
    finalModel,
    generating,
}: {
    session: Session;
    finalModel: string;
    generating: Generating | null;
}) {
    if (generating?.sessionId === session.id) {
        return (
            <>
                <StatusIndicator status={{ tone: 'active', text: `${generating.model} で要約を作成中…` }} />
                <Markdown streaming>{generating.text}</Markdown>
            </>
        );
    }

    const summary: Summary | undefined =
        session.summaries.findLast((s) => s.model === finalModel) ?? session.summaries.at(-1);
    if (!summary) {
        return <p className='text-sm text-muted-foreground'>まだ要約がありません。</p>;
    }

    return (
        <>
            <p className='text-xs text-muted-foreground'>
                {summary.model} で生成・{summary.generatedAt}
                {summary.model !== finalModel && `（${finalModel} の要約はまだありません）`}
            </p>
            <Markdown>{summary.text}</Markdown>
        </>
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
                    ? '左のメニューから過去のセッションを開くか、プロジェクトの ＋ から新しいセッションを作れます。'
                    : '左のメニューの「新規プロジェクト作成」から、録音をまとめるフォルダを選んでください。'}
            </p>
        </div>
    );
}
