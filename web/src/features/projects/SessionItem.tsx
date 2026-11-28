import { useDraggable } from '@dnd-kit/core';
import { FileAudioIcon } from 'lucide-react';

import type { Project, Session } from '@/api/types';
import { SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { projectsMessages } from '@/features/projects/i18n';
import { type Dragging, pointerOnly } from '@/features/projects/projectDrag';
import { sessionMeta } from '@/features/projects/sessionMeta';
import { contentLang } from '@/i18n/contentLang';
import { useT } from '@/i18n/messages';

// サイドバーのセッションの 1 行。ほかのプロジェクトへドラッグして移せる（#172）
export function SessionItem({
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
    const t = useT(projectsMessages);
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
                    <span className='truncate' lang={contentLang(session.title)}>
                        {session.title}
                    </span>
                    <span className='truncate text-xs text-muted-foreground tabular-nums'>{sessionMeta(session)}</span>
                </span>
            ) : (
                <span className='truncate' lang={contentLang(session.title)}>
                    {session.title}
                </span>
            )}
            {/* 音声ファイルから作ったセッションには、録音したものと見分けられる印を付ける */}
            {session.uploaded && (
                <FileAudioIcon
                    className='ml-auto size-3.5 shrink-0 text-muted-foreground'
                    aria-label={t('sessionItem.fromAudioFile')}
                />
            )}
            {/* 録音中（ほかの端末のものも含む）のセッションには赤い点を付ける */}
            {session.status === 'recording' && (
                <span
                    className='ml-auto size-2 shrink-0 rounded-full bg-red-500'
                    aria-label={t('sessionItem.recording')}
                />
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
