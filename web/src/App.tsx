import { useEffect } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
import { DevPanel } from '@/components/DevPanel';
import { MicButton } from '@/components/MicButton';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { SessionView } from '@/components/SessionView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { TopBar } from '@/components/TopBar';
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

    useEffect(() => {
        loadOptions();
    }, [loadOptions]);

    return (
        <SidebarProvider>
            <AppSidebar />
            <SidebarInset className='gap-4 p-4'>
                <TopBar />
                <SessionView />
                <MicButton />
            </SidebarInset>
            <NewProjectDialog
                open={newProjectOpen}
                onOpenChange={setNewProjectOpen}
                roots={settings.materials.roots}
                onCreate={(path) => toast.success(`${path} をプロジェクトにしました`)}
            />
            <SettingsDialog
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                settings={settings}
                options={options}
                onSave={(s) => {
                    changeSettings(s);
                    toast.success('設定を保存しました');
                }}
            />
            <DevPanel />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
