import type { ReactNode } from 'react';

import { useDroppable } from '@dnd-kit/core';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVerticalIcon, PlusIcon } from 'lucide-react';

import type { Project } from '@/api/types';
import { AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { projectsMessages } from '@/features/projects/i18n';
import { type ProjectDrag, pointerOnly } from '@/features/projects/projectDrag';
import { sortableId } from '@/features/projects/projectOrder';
import { useT } from '@/i18n/messages';

// 1 つのプロジェクト（見出しとセッションの一覧）。
// ここにセッションを離すと、このプロジェクトへ移す（#172）。見出しをドラッグすると、プロジェクトを並び替える（#173）
export function ProjectGroup({
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
    const t = useT(projectsMessages);
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
            {/* 「握り・名前 ⌄ ……… ＋」の並びにする（#234）。長押しで文字の選択やメニューが出ないようにする */}
            <div
                className='group/head flex items-center pr-1 select-none [-webkit-touch-callout:none]'
                // マウスと指で見出しのどこからでもドラッグできる。キーボードは握りだけ
                {...pointerOnly(sort.listeners)}
            >
                {/* キーボードで並び替える握り（Space で持ち上げ、矢印で動かし、Space で離す）。マウスの上とフォーカスしたときだけ見せる。
                    見えないときも幅は取ったままにして、名前の位置がずれないようにする */}
                <button
                    type='button'
                    ref={sort.setActivatorNodeRef}
                    className='-ml-0.5 flex size-4 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/50 opacity-0 group-hover/head:opacity-100 hover:text-sidebar-accent-foreground focus-visible:opacity-100'
                    aria-label={t('projectGroup.reorder', { name: project.name })}
                    onKeyDown={sort.listeners?.onKeyDown as React.KeyboardEventHandler | undefined}
                    {...sort.attributes}
                    role={undefined}
                    aria-disabled={undefined}
                >
                    <GripVerticalIcon size={14} />
                </button>
                <AccordionTrigger className='flex-none justify-start gap-1 py-1.5 text-xs text-sidebar-foreground/70 hover:no-underline **:data-[slot=accordion-trigger-icon]:ml-0'>
                    {project.name}
                </AccordionTrigger>
                <button
                    className={`ml-auto flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''}`}
                    aria-label={t('projectGroup.newSession', { name: project.name })}
                    onClick={onNewSession}
                >
                    <PlusIcon size={16} />
                </button>
            </div>
            {children}
        </AccordionItem>
    );
}
