import { PlusIcon } from 'lucide-react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { Project } from '@/mock';

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもできる
export function ProjectList({
    projects,
    activeProject,
    activeSession,
    onSelectSession,
    onNewSession,
}: {
    projects: Project[];
    activeProject: string | null;
    activeSession: string | null;
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
                        <button
                            className={`ml-auto flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground ${activeProject === project.id && activeSession === null ? 'bg-sidebar-accent text-sidebar-accent-foreground' : ''}`}
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
                                        onClick={() => onSelectSession(project.id, session.id)}
                                    >
                                        <span>{session.title}</span>
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
