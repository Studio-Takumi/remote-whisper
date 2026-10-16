import { FileAudioIcon, PlusIcon } from 'lucide-react';

import { AudioUploadButton } from '@/components/AudioUpload';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { formatElapsed, formatShortDateTime, sessionDuration } from '@/time';
import type { Project, Session } from '@/types';

// 録音日時と長さ（例: 10/11 14:05 · 1:23:45）。録音中は長さの代わりに「録音中」
function sessionMeta(session: Session) {
    const started = formatShortDateTime(session.startedAt);
    if (session.status === 'recording') {
        return `${started} · 録音中`;
    }
    const duration = sessionDuration(session);
    return duration === undefined ? started : `${started} · ${formatElapsed(Math.round(duration))}`;
}

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもできる
export function ProjectList({
    projects,
    activeProject,
    activeSession,
    showMeta,
    onSelectSession,
    onNewSession,
}: {
    projects: Project[];
    activeProject: string | null;
    activeSession: string | null;
    // セッションの録音日時と長さを出すか（全体設定の display.sessionMeta）
    showMeta: boolean;
    onSelectSession: (projectId: string, sessionId: string) => void;
    onNewSession: (projectId: string) => void;
}) {
    if (projects.length === 0) {
        return <p className='px-2 text-xs text-muted-foreground'>プロジェクトはまだありません</p>;
    }

    return (
        <Accordion type='multiple' defaultValue={projects.map((p) => p.id)}>
            {projects.map((project) => (
                <AccordionItem key={project.id} value={project.id} className='border-none'>
                    {/* Claude のサイドバーと同じく「名前 ⌄ ……… ＋」の並びにする */}
                    <div className='flex items-center pr-1 pl-2'>
                        <AccordionTrigger className='flex-none justify-start gap-1 py-1.5 text-xs text-sidebar-foreground/70 hover:no-underline **:data-[slot=accordion-trigger-icon]:ml-0'>
                            {project.name}
                        </AccordionTrigger>
                        {/* 音声ファイルから作る（#180） */}
                        <span className='ml-auto'>
                            <AudioUploadButton projectId={project.id} compact />
                        </span>
                        <button
                            className={`flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${activeProject === project.id && activeSession === null ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''}`}
                            aria-label={`${project.name}で新しく録音`}
                            onClick={() => onNewSession(project.id)}
                        >
                            <PlusIcon size={16} />
                        </button>
                    </div>
                    {/* ui/accordion は中身の高さを開いたときの値で固定するので、セッションが増えると下が隠れる。h-auto で上書きする */}
                    <AccordionContent className='h-auto pb-2'>
                        <SidebarMenu>
                            {project.sessions.map((session) => (
                                <SidebarMenuItem key={session.id}>
                                    <SidebarMenuButton
                                        isActive={session.id === activeSession}
                                        // 2行にするときは、高さを中身に合わせる
                                        className={showMeta ? 'h-auto py-1.5' : undefined}
                                        onClick={() => onSelectSession(project.id, session.id)}
                                    >
                                        {showMeta ? (
                                            // 録音日時と長さを、タイトルの下に小さく出す
                                            <span className='flex min-w-0 flex-col'>
                                                <span className='truncate'>{session.title}</span>
                                                <span className='truncate text-xs text-muted-foreground tabular-nums'>
                                                    {sessionMeta(session)}
                                                </span>
                                            </span>
                                        ) : (
                                            <span className='truncate'>{session.title}</span>
                                        )}
                                        {/* 音声ファイルから作ったセッションには、録音したものと見分けられる印を付ける */}
                                        {session.uploaded && (
                                            <FileAudioIcon
                                                className='ml-auto size-3.5 shrink-0 text-muted-foreground'
                                                aria-label='音声ファイルから作成'
                                            />
                                        )}
                                        {/* 録音中（ほかの端末のものも含む）のセッションには赤い点を付ける */}
                                        {session.status === 'recording' && (
                                            <span
                                                className='ml-auto size-2 shrink-0 rounded-full bg-red-500'
                                                aria-label='録音中'
                                            />
                                        )}
                                    </SidebarMenuButton>
                                </SidebarMenuItem>
                            ))}
                        </SidebarMenu>
                    </AccordionContent>
                </AccordionItem>
            ))}
        </Accordion>
    );
}
