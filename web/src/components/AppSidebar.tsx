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
import { useAppStore, visibleProjects } from '@/store';

export function AppSidebar() {
    const recording = useAppStore((s) => s.recordingState !== 'idle');
    const projects = useAppStore(visibleProjects);
    const selection = useAppStore((s) => s.selection);
    const selectSession = useAppStore((s) => s.selectSession);
    const newSession = useAppStore((s) => s.newSession);
    const setNewProjectOpen = useAppStore((s) => s.setNewProjectOpen);
    const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

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
                                <SidebarMenuButton
                                    tooltip='新規プロジェクト作成'
                                    onClick={() => setNewProjectOpen(true)}
                                >
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
                            activeProject={selection.projectId}
                            activeSession={selection.sessionId}
                            onSelectSession={selectSession}
                            onNewSession={newSession}
                        />
                    </RecordingLock>
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                <RecordingLock locked={recording}>
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton tooltip='設定' onClick={() => setSettingsOpen(true)}>
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
