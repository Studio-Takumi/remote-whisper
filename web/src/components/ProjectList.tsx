import { type ReactNode, useState } from 'react';

import {
    type CollisionDetection,
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    closestCenter,
    rectIntersection,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import {
    SortableContext,
    sortableKeyboardCoordinates,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { FileAudioIcon, GripVerticalIcon, PlusIcon } from 'lucide-react';

import { AudioUploadButton } from '@/components/AudioUpload';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { moveTarget } from '@/move';
import { projectIdOf, reorderedIds, sortableId } from '@/projectOrder';
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

// ドラッグしているセッション。data.type でプロジェクトの並び替え（#173）のドラッグと見分ける
type Dragging = { type: 'session'; sessionId: string; projectId: string; title: string };

// プロジェクトの見出しのドラッグ（並び替え）の data
type ProjectDrag = { type: 'project'; projectId: string };

// 同じ DndContext の中に、セッションを別のプロジェクトへ移すドラッグ（離す先はプロジェクトの枠）と、
// プロジェクトの並び替え（離す先はほかのプロジェクトの見出し）がある。どちらの枠が相手になるかは
// 枠を有効にするかで分けている（ProjectGroup）ので、判定の方法だけドラッグの種類で変える
const collisionDetection: CollisionDetection = (args) =>
    args.active.data.current?.type === 'project' ? closestCenter(args) : rectIntersection(args);

// useDraggable / useSortable の listeners からキーボードの操作を除いたもの。
// キーボードで始められるのは見出しの握りだけにする（セッションのボタンで Space を押したときに、選ぶ代わりに
// ドラッグが始まらないように）
function pointerOnly(listeners: Record<string, unknown> | undefined) {
    const { onKeyDown, ...rest } = listeners ?? {};
    void onKeyDown;
    return rest;
}

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもできる。
// セッションをほかのプロジェクト（見出しか一覧の中）へドラッグすると移せる（#172）。
// プロジェクトの見出しをドラッグすると並び替えられる（#173。セッションは並び替えられない）。
// マウスは少し動かしたら、指は長押ししてからドラッグが始まる（押すだけ・スクロールは今までどおり）。
// 並び替えはキーボードでもできる（見出しの握りにフォーカスして Space で持ち上げ、矢印で動かし、Space で離す）
export function ProjectList({
    projects,
    activeProject,
    activeSession,
    showMeta,
    onSelectSession,
    onNewSession,
    moveBlocker,
    onMove,
    onReorder,
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
    // セッションの ID はプロジェクトをまたぐと重なることがある（アップロードなど）ので、元のプロジェクトも渡す
    onMove: (fromProjectId: string, sessionId: string, toProjectId: string) => void;
    // プロジェクトを並び替えた（新しい並びのプロジェクト ID）
    onReorder: (projectIds: string[]) => void;
}) {
    const [dragging, setDragging] = useState<Dragging | null>(null);
    // 並び替えのためにドラッグしているプロジェクトがあるか
    const [reordering, setReordering] = useState(false);
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    if (projects.length === 0) {
        return <p className='px-2 text-xs text-muted-foreground'>プロジェクトはまだありません</p>;
    }

    const onDragStart = (e: DragStartEvent) => {
        const data = e.active.data.current as Dragging | ProjectDrag | undefined;
        if (data?.type === 'project') {
            setReordering(true);
        } else if (data?.type === 'session') {
            setDragging(data);
        }
    };
    const onDragEnd = (e: DragEndEvent) => {
        const data = e.active.data.current as Dragging | ProjectDrag | undefined;
        setDragging(null);
        setReordering(false);
        if (data?.type === 'project') {
            const ids = reorderedIds(
                projects.map((p) => p.id),
                data.projectId,
                projectIdOf(e.over?.id),
            );
            if (ids) {
                onReorder(ids);
            }
        } else if (data?.type === 'session') {
            const to = moveTarget(data.projectId, e.over ? String(e.over.id) : null);
            if (to) {
                onMove(data.projectId, data.sessionId, to);
            }
        }
    };
    const onDragCancel = () => {
        setDragging(null);
        setReordering(false);
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={collisionDetection}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={onDragCancel}
        >
            <SortableContext items={projects.map((p) => sortableId(p.id))} strategy={verticalListSortingStrategy}>
                <Accordion type='multiple' defaultValue={projects.map((p) => p.id)}>
                    {projects.map((project) => (
                        <ProjectGroup
                            key={project.id}
                            project={project}
                            // セッションをドラッグしている間は、ほかのプロジェクトが離す先になる
                            dropping={dragging !== null && dragging.projectId !== project.id}
                            sessionDragging={dragging !== null}
                            reordering={reordering}
                            active={activeProject === project.id && activeSession === null}
                            onNewSession={() => onNewSession(project.id)}
                        >
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
                                            dragging={
                                                dragging?.projectId === project.id && dragging.sessionId === session.id
                                            }
                                            onSelect={() => onSelectSession(project.id, session.id)}
                                        />
                                    ))}
                                </SidebarMenu>
                            </AccordionContent>
                        </ProjectGroup>
                    ))}
                </Accordion>
            </SortableContext>
            {/* セッションをドラッグしている間、指やカーソルの下にタイトルを出す（プロジェクトの並び替えは、枠そのものが動く） */}
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

// 1 つのプロジェクト（見出しとセッションの一覧）。
// ここにセッションを離すと、このプロジェクトへ移す（#172）。見出しをドラッグすると、プロジェクトを並び替える（#173）
function ProjectGroup({
    project,
    dropping,
    sessionDragging,
    reordering,
    active,
    onNewSession,
    children,
}: {
    project: Project;
    // ほかのプロジェクトのセッションをドラッグしている（ここに離せる）
    dropping: boolean;
    // どこかのセッションをドラッグしている
    sessionDragging: boolean;
    // プロジェクトを並び替えている
    reordering: boolean;
    // このプロジェクトの新しいセッションの画面を開いている
    active: boolean;
    onNewSession: () => void;
    children: ReactNode;
}) {
    // セッションを離す枠。プロジェクトを並び替えている間は、並び替えの枠と重ならないよう無効にする
    const drop = useDroppable({ id: project.id, disabled: reordering });
    // 並び替えの枠。セッションをドラッグしている間は無効にする（セッションは並び替えない）
    const sort = useSortable({
        id: sortableId(project.id),
        data: { type: 'project', projectId: project.id } satisfies ProjectDrag,
        disabled: sessionDragging,
    });
    const setRef = (node: HTMLElement | null) => {
        drop.setNodeRef(node);
        sort.setNodeRef(node);
    };
    return (
        <AccordionItem
            ref={setRef}
            value={project.id}
            data-drop-target={dropping ? (drop.isOver ? 'over' : 'ready') : undefined}
            data-sorting={sort.isDragging ? 'true' : undefined}
            style={{ transform: CSS.Translate.toString(sort.transform), transition: sort.transition }}
            className={`relative rounded-md border-none transition-colors ${dropping && drop.isOver ? 'bg-sidebar-accent ring-2 ring-primary/40' : ''} ${sort.isDragging ? 'z-10 bg-sidebar opacity-90 shadow-md' : ''}`}
        >
            {/* Claude のサイドバーと同じく「名前 ⌄ ……… ＋」の並びにする。長押しで文字の選択やメニューが出ないようにする */}
            <div
                className='group/head flex items-center pr-1 pl-2 select-none [-webkit-touch-callout:none]'
                // マウスと指で見出しのどこからでもドラッグできる。キーボードは握りだけ
                {...pointerOnly(sort.listeners)}
            >
                <AccordionTrigger className='flex-none justify-start gap-1 py-1.5 text-xs text-sidebar-foreground/70 hover:no-underline **:data-[slot=accordion-trigger-icon]:ml-0'>
                    {project.name}
                </AccordionTrigger>
                {/* キーボードで並び替える握り（Space で持ち上げ、矢印で動かし、Space で離す）。マウスの上にだけ見せる */}
                <button
                    type='button'
                    ref={sort.setActivatorNodeRef}
                    className='ml-1 flex size-5 items-center justify-center rounded-md text-sidebar-foreground/50 opacity-0 group-hover/head:opacity-100 hover:text-sidebar-accent-foreground focus-visible:opacity-100'
                    aria-label={`${project.name}の並び順を変える`}
                    onKeyDown={sort.listeners?.onKeyDown as React.KeyboardEventHandler | undefined}
                    {...sort.attributes}
                    role={undefined}
                    aria-disabled={undefined}
                >
                    <GripVerticalIcon size={14} />
                </button>
                {/* 音声ファイルから作る（#180） */}
                <span className='ml-auto'>
                    <AudioUploadButton projectId={project.id} compact />
                </span>
                <button
                    className={`flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''}`}
                    aria-label={`${project.name}で新しく録音`}
                    onClick={onNewSession}
                >
                    <PlusIcon size={16} />
                </button>
            </div>
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
    const data: Dragging = { type: 'session', sessionId: session.id, projectId: project.id, title: session.title };
    const { setNodeRef, attributes, listeners } = useDraggable({
        // セッションの ID はプロジェクトをまたぐと重なることがあるので、プロジェクトの ID を付ける
        id: `${project.id}:${session.id}`,
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
            {...pointerOnly(listeners)}
            // dnd-kit の attributes は role="button" を付けるが、もともと button なので要らない。
            // 移せないときに付く aria-disabled も外す（サイドバーのボタンは aria-disabled だと押せなくなる）
            role={undefined}
            aria-disabled={undefined}
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
