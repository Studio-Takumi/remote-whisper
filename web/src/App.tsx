import { useEffect } from 'react';

import { toast } from 'sonner';

import { isReady, useCloudStore } from '@/cloud';
import { AppSidebar } from '@/components/AppSidebar';
import { CloudEntry } from '@/components/CloudEntry';
import { DevPanel } from '@/components/DevPanel';
import { MicButton } from '@/components/MicButton';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { PwaUpdater } from '@/components/PwaUpdater';
import { SessionView } from '@/components/SessionView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { TopBar } from '@/components/TopBar';
import { UnsentAlert } from '@/components/UnsentAlert';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { isCloud } from '@/endpoint';
import { startRouter } from '@/router';
import { useAppStore } from '@/store';

// クラウド版は、ログイン・同意・ホストの選択（#156）がすんでホストにつながるまで、今のアプリを出さない。
// ダイレクト版は常にそのまま出す
function App() {
    const ready = useCloudStore((s) => isReady(s.cloud));
    return !isCloud || ready ? <AppMain /> : <CloudEntry />;
}

function AppMain() {
    const settings = useAppStore((s) => s.settings);
    const changeSettings = useAppStore((s) => s.changeSettings);
    const settingsOpen = useAppStore((s) => s.settingsOpen);
    const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
    const settingsPage = useAppStore((s) => s.settingsPage);
    const setSettingsPage = useAppStore((s) => s.setSettingsPage);
    const newProjectOpen = useAppStore((s) => s.newProjectOpen);
    const setNewProjectOpen = useAppStore((s) => s.setNewProjectOpen);
    const loadOptions = useAppStore((s) => s.loadOptions);
    const options = useAppStore((s) => s.options);
    const recording = useAppStore((s) => s.recordingState !== 'idle');

    const watchMicrophone = useAppStore((s) => s.watchMicrophone);
    const connectServer = useAppStore((s) => s.connectServer);
    const loadSettings = useAppStore((s) => s.loadSettings);
    const loadProjects = useAppStore((s) => s.loadProjects);
    const createProject = useAppStore((s) => s.createProject);

    // 画面の URL（#177）。開いているセッションと設定モーダルを URL に出し、URL から開く
    useEffect(
        () =>
            startRouter({
                getState: useAppStore.getState,
                subscribe: useAppStore.subscribe,
                setState: useAppStore.setState,
                open: ({ projectId, sessionId }) => {
                    const s = useAppStore.getState();
                    if (projectId && sessionId) {
                        s.selectSession(projectId, sessionId);
                    } else if (projectId) {
                        s.newSession(projectId);
                    } else {
                        useAppStore.setState({ selection: { projectId: null, sessionId: null } });
                    }
                },
            }),
        [],
    );

    useEffect(() => {
        loadOptions();
        loadSettings();
        loadProjects();
        watchMicrophone();
        connectServer();
    }, [loadOptions, loadSettings, loadProjects, watchMicrophone, connectServer]);

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className='gap-4 p-4'>
                <TopBar />
                <UnsentAlert />
                <PwaUpdater />
                <SessionView />
                <MicButton />
            </SidebarInset>
            <NewProjectDialog open={newProjectOpen} onOpenChange={setNewProjectOpen} onCreate={createProject} />
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                page={settingsPage}
                onPageChange={setSettingsPage}
                settings={settings}
                options={options}
                recording={recording}
                onSave={async (s) => {
                    if (await changeSettings(s)) {
                        toast.success('設定を保存しました');
                    }
                }}
            />
            <DevPanel />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
