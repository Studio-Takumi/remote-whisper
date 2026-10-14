import { PlusIcon, SettingsIcon } from 'lucide-react';

import { ProjectList } from '@/components/ProjectList';
import { ThemeToggle } from '@/components/ThemeToggle';
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
    useSidebar,
} from '@/components/ui/sidebar';
import { useAppStore, visibleProjects } from '@/store';

// 録音中でも、新規プロジェクトの作成・ほかのセッションを開く・設定を開くことはできる（#133）。
// 録音中のセッションには、マイクのボタン（「録音中のセッションに戻る」）か左メニューの赤い点から戻れる
export function AppSidebar() {
    const projects = useAppStore(visibleProjects);
    const selection = useAppStore((s) => s.selection);
    const showMeta = useAppStore((s) => s.settings.display.sessionMeta);
    const selectSession = useAppStore((s) => s.selectSession);
    const newSession = useAppStore((s) => s.newSession);
    // スマホの幅ではサイドバーはシートとして重なるので、セッションを選んだら閉じる
    const { setOpenMobile } = useSidebar();
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
                    <SidebarMenu>
                        <SidebarMenuItem>
                            <SidebarMenuButton
                                tooltip='新規プロジェクト作成'
                                onClick={() => {
                                    setOpenMobile(false);
                                    setNewProjectOpen(true);
                                }}
                            >
                                <PlusIcon />
                                <span>新規プロジェクト作成</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                    </SidebarMenu>
                </SidebarGroup>
                <SidebarGroup className='group-data-[collapsible=icon]:hidden'>
                    <ProjectList
                        projects={projects}
                        activeProject={selection.projectId}
                        activeSession={selection.sessionId}
                        showMeta={showMeta}
                        onSelectSession={(projectId, sessionId) => {
                            selectSession(projectId, sessionId);
                            setOpenMobile(false);
                        }}
                        onNewSession={(projectId) => {
                            newSession(projectId);
                            setOpenMobile(false);
                        }}
                    />
                </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
                {/* テーマは全体設定ではなく、この端末の見た目 */}
                <SidebarMenu>
                    <SidebarMenuItem>
                        <ThemeToggle />
                    </SidebarMenuItem>
                </SidebarMenu>
                {/* 録音中に変えられない項目は、設定画面の中で項目ごとに押せなくする */}
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton
                            tooltip='設定'
                            onClick={() => {
                                setOpenMobile(false);
                                setSettingsOpen(true);
                            }}
                        >
                            <SettingsIcon />
                            <span>設定</span>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarFooter>
        </Sidebar>
    );
}
