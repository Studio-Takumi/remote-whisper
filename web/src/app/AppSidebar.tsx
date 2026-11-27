import { useState } from 'react';

import { PlusIcon, SettingsIcon, UserIcon } from 'lucide-react';

import { isCloud } from '@/api/endpoint';
import { appMessages } from '@/app/i18n';
import { useProjects } from '@/app/sessionHooks';
import { useAppStore } from '@/app/store';
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
import { AccountDialog } from '@/features/cloud/AccountDialog';
import { ProjectList } from '@/features/projects/ProjectList';
import { moveBlocker } from '@/features/projects/move';
import { ThemeToggle } from '@/features/settings/ThemeToggle';
import { useT } from '@/i18n/messages';

// 録音中でも、新規プロジェクトの作成・ほかのセッションを開く・設定を開くことはできる（#133）。
// 録音中のセッションには、マイクのボタン（「録音中のセッションに戻る」）か左メニューの赤い点から戻れる
export function AppSidebar() {
    const t = useT(appMessages);
    const projects = useProjects();
    const selection = useAppStore((s) => s.selection);
    const showMeta = useAppStore((s) => s.settings.display.sessionMeta);
    const selectSession = useAppStore((s) => s.selectSession);
    const newSession = useAppStore((s) => s.newSession);
    const moveSession = useAppStore((s) => s.moveSession);
    const [accountOpen, setAccountOpen] = useState(false);
    const reorderProjects = useAppStore((s) => s.reorderProjects);
    // セッションを移せるか（#172）を見るのに使う
    const server = useAppStore((s) => s.server);
    const recordingSessionId = useAppStore((s) => s.recordingSessionId);
    // スマホの幅ではサイドバーはシートとして重なるので、セッションを選んだら閉じる
    const { setOpenMobile } = useSidebar();
    const setNewProjectOpen = useAppStore((s) => s.setNewProjectOpen);
    const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

    return (
        <>
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
                                    tooltip={t('appSidebar.newProject')}
                                    onClick={() => {
                                        setOpenMobile(false);
                                        setNewProjectOpen(true);
                                    }}
                                >
                                    <PlusIcon />
                                    <span>{t('appSidebar.newProject')}</span>
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
                            moveBlocker={(session) =>
                                moveBlocker(session, {
                                    jobs: server.jobs,
                                    transcribing: server.transcribing,
                                    summarizing: server.summarizing,
                                    recordingSessionId,
                                })
                            }
                            onMove={(from, sessionId, to) => void moveSession(from, sessionId, to)}
                            onReorder={(ids) => void reorderProjects(ids)}
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
                                tooltip={t('appSidebar.settings')}
                                onClick={() => {
                                    setOpenMobile(false);
                                    setSettingsOpen(true);
                                }}
                            >
                                <SettingsIcon />
                                <span>{t('appSidebar.settings')}</span>
                            </SidebarMenuButton>
                        </SidebarMenuItem>
                        {/* クラウド版のときだけ、アカウント（#155） */}
                        {isCloud && (
                            <SidebarMenuItem>
                                <SidebarMenuButton
                                    tooltip={t('appSidebar.account')}
                                    onClick={() => {
                                        setOpenMobile(false);
                                        setAccountOpen(true);
                                    }}
                                >
                                    <UserIcon />
                                    <span>{t('appSidebar.account')}</span>
                                </SidebarMenuButton>
                            </SidebarMenuItem>
                        )}
                    </SidebarMenu>
                </SidebarFooter>
            </Sidebar>
            {/* スマホではサイドバーが閉じると中身が消えるので、ダイアログはサイドバーの外に置く */}
            {isCloud && <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />}
        </>
    );
}
