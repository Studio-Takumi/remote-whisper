import { useEffect } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
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
import { useAppStore } from '@/store';

function App() {
    const settings = useAppStore((s) => s.settings);
    const changeSettings = useAppStore((s) => s.changeSettings);
    const settingsOpen = useAppStore((s) => s.settingsOpen);
    const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
    const newProjectOpen = useAppStore((s) => s.newProjectOpen);
    const setNewProjectOpen = useAppStore((s) => s.setNewProjectOpen);
    const loadOptions = useAppStore((s) => s.loadOptions);
    const options = useAppStore((s) => s.options);

    const watchMicrophone = useAppStore((s) => s.watchMicrophone);
    const connectServer = useAppStore((s) => s.connectServer);
    const loadSettings = useAppStore((s) => s.loadSettings);
    const loadProjects = useAppStore((s) => s.loadProjects);
    const createProject = useAppStore((s) => s.createProject);

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
                settings={settings}
                options={options}
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
