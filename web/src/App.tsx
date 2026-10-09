import { useState } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
import { DevPanel } from '@/components/DevPanel';
import { MicButton, type MicTarget } from '@/components/MicButton';
import { NewProjectDialog } from '@/components/NewProjectDialog';
import { SessionView } from '@/components/SessionView';
import { SettingsDialog } from '@/components/SettingsDialog';
import { TopBar } from '@/components/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { useRecordingTimer } from '@/hooks/useRecordingTimer';
import { projects } from '@/mock';
import type { RecordingState } from '@/recording';
import { defaultSettings } from '@/settings';
import { initialServerStatus } from '@/status';

type Selection = { projectId: string | null; sessionId: string | null };

function App() {
    const [selection, setSelection] = useState<Selection>({ projectId: null, sessionId: null });
    const [recordingState, setRecordingState] = useState<RecordingState>('idle');
    const recording = recordingState !== 'idle';
    const timer = useRecordingTimer(recordingState);
    const [settings, setSettings] = useState(defaultSettings);
    const [server, setServer] = useState(initialServerStatus);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [newProjectOpen, setNewProjectOpen] = useState(false);
    const [noProjects, setNoProjects] = useState(false);

    const visibleProjects = noProjects ? [] : projects;
    const project = visibleProjects.find((p) => p.id === selection.projectId);
    const session = project?.sessions.find((s) => s.id === selection.sessionId);

    const micTarget: MicTarget = !project
        ? { kind: 'none' }
        : session
          ? { kind: 'session', projectName: project.name }
          : { kind: 'new' };

    function startRecording() {
        if (!project) {
            toast.info('録音するプロジェクトを左のメニューから選んでください');
            return;
        }
        if (server.microphone === 'denied') {
            toast.error('マイクが使えません。ブラウザの設定でマイクを許可してください');
            return;
        }
        // 既存のセッションを開いていたら、同じプロジェクトの新しいセッションの画面に切り替える
        setSelection({ projectId: project.id, sessionId: null });
        timer.reset();
        setRecordingState('recording');
        // Whisper は録音を始めたときに読み込む（spec 6.2 節）
        if (server.whisper === 'unloaded') {
            setServer((s) => ({ ...s, whisper: 'loading' }));
            setTimeout(() => setServer((s) => (s.whisper === 'loading' ? { ...s, whisper: 'ready' } : s)), 2000);
        }
    }

    return (
        <SidebarProvider>
            <AppSidebar
                recording={recording}
                projects={visibleProjects}
                activeProject={selection.projectId}
                activeSession={selection.sessionId}
                onSelectSession={(projectId, sessionId) => setSelection({ projectId, sessionId })}
                onNewSession={(projectId) => setSelection({ projectId, sessionId: null })}
                onNewProject={() => setNewProjectOpen(true)}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <SidebarInset className='gap-4 p-4'>
                <TopBar recording={recording} settings={settings} onChangeSettings={setSettings} />
                <SessionView
                    hasProjects={visibleProjects.length > 0}
                    project={project}
                    session={session}
                    recordingState={recordingState}
                    server={server}
                    liveIntervalMin={settings.ollama.liveSummaryIntervalMin}
                />
                <MicButton
                    state={recordingState}
                    target={micTarget}
                    elapsed={timer.elapsed}
                    onStart={startRecording}
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
            <DevPanel
                server={server}
                onChangeServer={setServer}
                noProjects={noProjects}
                onChangeNoProjects={setNoProjects}
            />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
