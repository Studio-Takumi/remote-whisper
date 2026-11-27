import { useState } from 'react';

import {
    type Announcements,
    DndContext,
    type DragEndEvent,
    DragOverlay,
    type DragStartEvent,
    KeyboardSensor,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';

import type { Project, Session } from '@/api/types';
import { Accordion, AccordionContent } from '@/components/ui/accordion';
import { SidebarMenu } from '@/components/ui/sidebar';
import { connectedHostId } from '@/features/cloud/hosts';
import { ProjectGroup } from '@/features/projects/ProjectGroup';
import { SessionItem } from '@/features/projects/SessionItem';
import { projectsMessages } from '@/features/projects/i18n';
import { moveTarget } from '@/features/projects/move';
import { type Dragging, type ProjectDrag, collisionDetection, dragName } from '@/features/projects/projectDrag';
import { closedIds, loadClosed, openIds, saveClosed } from '@/features/projects/projectFold';
import { projectIdOf, reorderedIds, sortableId } from '@/features/projects/projectOrder';
import { useT } from '@/i18n/messages';

// サイドバーのプロジェクト一覧。開閉の記憶（#318）、セッションの移動（#172）、プロジェクトの並び替え（#173）は
// spec/ui.md 8。マウスは少し動かして、指は長押しでドラッグが始まる
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
    const t = useT(projectsMessages);
    const [dragging, setDragging] = useState<Dragging | null>(null);
    // 並び替えのためにドラッグしているプロジェクトがあるか
    const [reordering, setReordering] = useState(false);
    // 閉じているプロジェクト（#318）は端末・ホストごとに覚え、ホストが変わったら読み直す。
    // 開くのは開いているセッションが変わったときだけ（再作成では開き直さない。spec/ui.md 8）
    const hostId = connectedHostId();
    const selected = activeProject !== null && activeSession !== null ? `${activeProject}\n${activeSession}` : null;
    const [fold, setFold] = useState(() => ({ hostId, closed: loadClosed(hostId), selected }));
    if (fold.hostId !== hostId || fold.selected !== selected) {
        const closed = fold.hostId === hostId ? fold.closed : loadClosed(hostId);
        setFold({
            hostId,
            closed: selected === null ? closed : closed.filter((id) => id !== activeProject),
            selected,
        });
    }
    const setClosed = (closed: string[]) => {
        setFold({ hostId, closed, selected });
        saveClosed(hostId, closed);
    };
    const sensors = useSensors(
        useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 400, tolerance: 8 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );

    if (projects.length === 0) {
        return <p className='px-2 text-xs text-muted-foreground'>{t('projectList.empty')}</p>;
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
    // 読み上げの案内。既定の英語の案内はドラッグの ID（プロジェクト ID にはパスが入る）を読むので、名前で案内する
    const nameOf = (id: string | number | undefined | null) => dragName(projects, id);
    const announcements: Announcements = {
        onDragStart: ({ active }) => t('projectList.dragStart', { name: nameOf(active.id) }),
        onDragOver: ({ active, over }) =>
            over ? t('projectList.dragOver', { name: nameOf(active.id), over: nameOf(over.id) }) : undefined,
        onDragEnd: ({ active, over }) =>
            over
                ? t('projectList.dragEndDropped', { name: nameOf(active.id), over: nameOf(over.id) })
                : t('projectList.dragEndReturned', { name: nameOf(active.id) }),
        onDragCancel: ({ active }) => t('projectList.dragCancel', { name: nameOf(active.id) }),
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
            accessibility={{ announcements, screenReaderInstructions: { draggable: t('projectDrag.instructions') } }}
        >
            <SortableContext items={projects.map((p) => sortableId(p.id))} strategy={verticalListSortingStrategy}>
                <Accordion
                    type='multiple'
                    value={openIds(
                        projects.map((p) => p.id),
                        fold.closed,
                    )}
                    onValueChange={(open) =>
                        setClosed(
                            closedIds(
                                projects.map((p) => p.id),
                                open,
                            ),
                        )
                    }
                >
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
