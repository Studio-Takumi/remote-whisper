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
import type { Project } from '@/mock';

export function AppSidebar({
    recording,
    projects,
    activeProject,
    activeSession,
    onSelectSession,
    onNewSession,
    onNewProject,
    onOpenSettings,
}: {
    recording: boolean;
    projects: Project[];
    activeProject: string | null;
    activeSession: string | null;
    onSelectSession: (projectId: string, sessionId: string) => void;
    onNewSession: (projectId: string) => void;
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
                    {/* 録音中に別のセッションを開くと、録音中の画面に戻れなくなるのでロックする */}
                    <RecordingLock locked={recording} message='録音中は他のセッションを開けません'>
                        <ProjectList
                            projects={projects}
                            activeProject={activeProject}
                            activeSession={activeSession}
                            onSelectSession={onSelectSession}
                            onNewSession={onNewSession}
                        />
                    </RecordingLock>
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
