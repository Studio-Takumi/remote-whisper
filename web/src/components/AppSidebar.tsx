import { PlusIcon, SettingsIcon } from 'lucide-react';

import { ProjectList } from '@/components/ProjectList';
import { RecordingLock } from '@/components/RecordingLock';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarGroup,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
    SidebarTrigger,
} from '@/components/ui/sidebar';
import { projects } from '@/mock';

export function AppSidebar({
    recording,
    activeSession,
    onSelectSession,
    onNewProject,
    onOpenSettings,
}: {
    recording: boolean;
    activeSession: string;
    onSelectSession: (session: string) => void;
    onNewProject: () => void;
    onOpenSettings: () => void;
}) {
    return (
        <Sidebar collapsible='icon'>
            <SidebarHeader className='flex flex-row items-center justify-between'>
                <p className='text-xl font-semibold group-data-[collapsible=icon]:hidden'>Remote Whisper</p>
                <SidebarTrigger />
            </SidebarHeader>
            <SidebarContent>
                <SidebarGroup>
                    <RecordingLock locked={recording} message='録音中はプロジェクトを作成できません'>
                        <SidebarMenu>
                            <SidebarMenuItem>
                                <SidebarMenuButton tooltip='新規プロジェクト作成' onClick={onNewProject}>
                                    <PlusIcon />
                                    <span>新規プロジェクト作成</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        </SidebarMenu>
                    </RecordingLock>
                </SidebarGroup>
                <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
                    <ProjectList projects={projects} activeSession={activeSession} onSelectSession={onSelectSession} />
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <RecordingLock locked={recording}>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton tooltip='設定' onClick={onOpenSettings}>
                                <SettingsIcon />
                                <span>設定</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </RecordingLock>
            </SidebarFooter>
        </Sidebar>
    );
}
