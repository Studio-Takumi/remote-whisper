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
import { moveTarget } from '@/features/projects/move';
import {
    type Dragging,
    type ProjectDrag,
    collisionDetection,
    dragName,
    screenReaderInstructions,
} from '@/features/projects/projectDrag';
import { closedIds, loadClosed, openIds, saveClosed } from '@/features/projects/projectFold';
import { projectIdOf, reorderedIds, sortableId } from '@/features/projects/projectOrder';

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもでき、閉じたものはこの端末に覚える（#318）。
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
    // 閉じているプロジェクト（#318）。端末ごと・ホストごとに覚える。クラウド版では、ホストにつなぐ前に
    // 作られることがあるので、つないだホストが変わったら読み直す（ホストを替えるとページごと読み込み直す）
    // 閉じているプロジェクトのセッションを開いたら（URL・通知・ジョブの一覧から）、そのプロジェクトを開く。
    // 開いているセッションが変わったときだけ見る（開いたまま見出しを閉じるのは止めない）。作り直したとき
    // （スマホでシートを開き直す・読み込み直す）は、変わったとはみなさない（閉じたものを開き直さない）
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
    // 読み上げの案内。既定の英語の案内はドラッグの ID（プロジェクト ID にはパスが入る）を読むので、名前で案内する
    const nameOf = (id: string | number | undefined | null) => dragName(projects, id);
    const announcements: Announcements = {
        onDragStart: ({ active }) => `「${nameOf(active.id)}」を持ち上げました`,
        onDragOver: ({ active, over }) =>
            over ? `「${nameOf(active.id)}」を「${nameOf(over.id)}」の位置に動かしています` : undefined,
        onDragEnd: ({ active, over }) =>
            over
                ? `「${nameOf(active.id)}」を「${nameOf(over.id)}」の位置に置きました`
                : `「${nameOf(active.id)}」を戻しました`,
        onDragCancel: ({ active }) => `「${nameOf(active.id)}」の移動をやめました`,
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
            accessibility={{ announcements, screenReaderInstructions }}
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
