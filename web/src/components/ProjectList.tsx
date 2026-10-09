import { PlusIcon } from 'lucide-react';

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import type { Project } from '@/mock';

// サイドバーのプロジェクト一覧。基本は全部開いておく。閉じることもできる
export function ProjectList({
    projects,
    activeSession,
    onSelectSession,
}: {
    projects: Project[];
    activeSession: string;
    onSelectSession: (sessionId: string) => void;
}) {
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
                            className='ml-auto flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
                            aria-label={`${project.name}で新しく録音`}
                        >
                            <PlusIcon size={16} />
                        </button>
                    </div>
                    <AccordionContent className='pb-2'>
                        <SidebarMenu>
                            {project.sessions.map((session) => (
                                <SidebarMenuItem key={session.id}>
                                    <SidebarMenuButton
                                        isActive={session.id === activeSession}
                                        onClick={() => onSelectSession(session.id)}
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
