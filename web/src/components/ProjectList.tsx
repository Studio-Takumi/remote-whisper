import { type ReactNode, useState } from 'react';

import {
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    MouseSensor,
    TouchSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import { FileAudioIcon, PlusIcon } from 'lucide-react';

import { AudioUploadButton } from '@/components/AudioUpload';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { moveTarget } from '@/move';
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

// ドラッグしているセッション
type Dragging = { sessionId: string; projectId: string; title: string };

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもできる。
// セッションをほかのプロジェクト（見出しか一覧の中）へドラッグすると移せる（#172）。
// マウスは少し動かしたら、指は長押ししてからドラッグが始まる（押すだけ・スクロールは今までどおり）
export function ProjectList({
    projects,
    activeProject,
    activeSession,
    showMeta,
    onSelectSession,
    onNewSession,
    moveBlocker,
    onMove,
}: {
    projects: Project[];
    activeProject: string | null;
    activeSession: string | null;
    // セッションの録音日時と長さを出すか（全体設定の display.sessionMeta）
    showMeta: boolean;
    onSelectSession: (projectId: string, sessionId: string) => void;
    onNewSession: (projectId: string) => void;
    // セッションを移せない理由（移せるなら null）
    moveBlocker: (session: Session) => string | null;
    onMove: (sessionId: string, toProjectId: string) => void;
}) {
    const [dragging, setDragging] = useState<Dragging | null>(null);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
    );

    if (projects.length === 0) {
        return <p className='px-2 text-xs text-muted-foreground'>プロジェクトはまだありません</p>;
    }

    const onDragStart = (e: DragStartEvent) => {
        setDragging((e.active.data.current as Dragging | undefined) ?? null);
    };
    const onDragEnd = (e: DragEndEvent) => {
        const from = (e.active.data.current as Dragging | undefined)?.projectId;
        const to = from ? moveTarget(from, e.over ? String(e.over.id) : null) : null;
        setDragging(null);
        if (to) {
            onMove(String(e.active.id), to);
        }
    };

    return (
        <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDragging(null)}
        >
            <Accordion type='multiple' defaultValue={projects.map((p) => p.id)}>
                {projects.map((project) => (
                    <ProjectGroup
                        key={project.id}
                        project={project}
                        dropping={dragging !== null && dragging.projectId !== project.id}
                    >
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
                                    <SessionItem
                                        key={session.id}
                                        project={project}
                                        session={session}
                                        active={session.id === activeSession}
                                        showMeta={showMeta}
                                        blocker={moveBlocker(session)}
                                        dragging={dragging?.sessionId === session.id}
                                        onSelect={() => onSelectSession(project.id, session.id)}
                                    />
                                ))}
                            </SidebarMenu>
                        </AccordionContent>
                    </ProjectGroup>
                ))}
            </Accordion>
            {/* ドラッグしている間、指やカーソルの下にタイトルを出す */}
            <DragOverlay dropAnimation={null}>
                {dragging && (
                    <div className='max-w-60 truncate rounded-md border bg-sidebar px-2 py-1.5 text-sm shadow-md'>
                        {dragging.title}
                    </div>
                )}
            </DragOverlay>
        </DndContext>
    );
}

// 1 つのプロジェクト（見出しとセッションの一覧）。ここに離すと、このプロジェクトへ移す
function ProjectGroup({
    project,
    dropping,
    children,
}: {
    project: Project;
    // ほかのプロジェクトのセッションをドラッグしている（ここに離せる）
    dropping: boolean;
    children: ReactNode;
}) {
    const { setNodeRef, isOver } = useDroppable({ id: project.id });
    return (
        <AccordionItem
            ref={setNodeRef}
            value={project.id}
            data-drop-target={dropping ? (isOver ? 'over' : 'ready') : undefined}
            className={`rounded-md border-none transition-colors ${dropping && isOver ? 'bg-sidebar-accent ring-2 ring-primary/40' : ''}`}
        >
            {children}
        </AccordionItem>
    );
}

function SessionItem({
    project,
    session,
    active,
    showMeta,
    blocker,
    dragging,
    onSelect,
}: {
    project: Project;
    session: Session;
    active: boolean;
    showMeta: boolean;
    blocker: string | null;
    dragging: boolean;
    onSelect: () => void;
}) {
    const data: Dragging = { sessionId: session.id, projectId: project.id, title: session.title };
    const { setNodeRef, attributes, listeners } = useDraggable({
        id: session.id,
        data,
        // 移せないセッションはドラッグを始められない（理由は Tooltip で出す）
        disabled: blocker !== null,
    });
    const button = (
        <SidebarMenuButton
            isActive={active}
            // 2行にするときは、高さを中身に合わせる。長押しで文字の選択やメニューが出ないようにする
            className={`select-none [-webkit-touch-callout:none] ${showMeta ? 'h-auto py-1.5' : ''} ${dragging ? 'opacity-40' : ''}`}
            onClick={onSelect}
            {...attributes}
            {...listeners}
            // dnd-kit の attributes は role="button" を付けるが、もともと button なので要らない
            role={undefined}
        >
            {showMeta ? (
                // 録音日時と長さを、タイトルの下に小さく出す
                <span className='flex min-w-0 flex-col'>
                    <span className='truncate'>{session.title}</span>
                    <span className='truncate text-xs text-muted-foreground tabular-nums'>{sessionMeta(session)}</span>
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
                <span className='ml-auto size-2 shrink-0 rounded-full bg-red-500' aria-label='録音中' />
            )}
        </SidebarMenuButton>
    );
    return (
        <SidebarMenuItem ref={setNodeRef}>
            {blocker ? (
                <Tooltip>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent side='right'>{blocker}</TooltipContent>
                </Tooltip>
            ) : (
                button
            )}
        </SidebarMenuItem>
    );
}
