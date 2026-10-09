import { useState } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
import { MicButton } from '@/components/MicButton';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { SessionView } from '@/components/SessionView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { TopBar } from '@/components/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { findSession, projects } from '@/mock';
import type { RecordingState } from '@/recording';
import { defaultSettings } from '@/settings';

function App() {
    const [recordingState, setRecordingState] = useState<RecordingState>('idle');
    const recording = recordingState !== 'idle';
    const [activeSession, setActiveSession] = useState(projects[0].sessions[0].id);
    const [settings, setSettings] = useState(defaultSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);

    return (
        <SidebarProvider>
            <AppSidebar
                recording={recording}
                activeSession={activeSession}
                onSelectSession={setActiveSession}
                onNewProject={() => setNewProjectOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <SidebarInset className='gap-4 p-4'>
                <TopBar recording={recording} settings={settings} onChangeSettings={setSettings} />
                <SessionView session={findSession(activeSession)} recordingState={recordingState} />
                <MicButton
                    state={recordingState}
                    onStart={() => setRecordingState('recording')}
                    onStop={() => setRecordingState('idle')}
                    onPause={() => setRecordingState('paused')}
                    onResume={() => setRecordingState('recording')}
                />
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
                onSave={(s) => {
                    setSettings(s);
                    toast.success('設定を保存しました');
                }}
            />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
