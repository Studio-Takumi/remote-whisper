import { useEffect } from 'react';

import { toast } from 'sonner';

import { isDemo } from '@/api/demo';
import { isDemoBuild } from '@/api/demoBuild';
import { isCloud } from '@/api/endpoint';
import { AppSidebar } from '@/app/AppSidebar';
import { DevPanel } from '@/app/DevPanel';
import { PwaUpdater } from '@/app/PwaUpdater';
import { TopBar } from '@/app/TopBar';
import { startRouter } from '@/app/router';
import { routerStore } from '@/app/routerStore';
import { useAppStore } from '@/app/store';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { AnnouncementBanner } from '@/features/cloud/AnnouncementBanner';
import { CloudEntry } from '@/features/cloud/CloudEntry';
import { PairPage } from '@/features/cloud/PairPage';
import { isReady, useCloudStore } from '@/features/cloud/cloud';
import { pairingCode } from '@/features/cloud/pairing';
import { NewProjectDialog } from '@/features/projects/NewProjectDialog';
import { MicButton } from '@/features/recording/MicButton';
import { UnsentAlert } from '@/features/recording/UnsentAlert';
import { UnsentElsewhereAlert } from '@/features/recording/UnsentElsewhereAlert';
import { SessionView } from '@/features/session/SessionView';
import { SettingsDialog } from '@/features/settings/SettingsDialog';
import { SetupDialog } from '@/features/setup/SetupDialog';

// クラウド版は、ログイン・同意・ホストの選択（#156）がすんでホストにつながるまで、今のアプリを出さない。
// セルフホスト版は常にそのまま出す。クラウド版の /pair?code=… は、ホストの登録の確認（#157）
function App() {
    const ready = useCloudStore((s) => isReady(s.cloud));
    const code = isCloud ? pairingCode(location) : null;
    if (code !== null) {
        return <PairPage code={code} />;
    }
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
    const settingsLoaded = useAppStore((s) => s.settingsLoaded);
    const loadProjects = useAppStore((s) => s.loadProjects);
    const createProject = useAppStore((s) => s.createProject);

    // 画面の URL（#177）。開いているセッションと設定モーダルを URL に出し、URL から開く
    useEffect(() => startRouter(routerStore), []);

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
                {/* お知らせはクラウド版だけ。デモ版（#414）は、クラウド用のドメインに置いても出さない */}
                {!isDemoBuild && <AnnouncementBanner />}
                <TopBar />
                <UnsentAlert />
                <UnsentElsewhereAlert />
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
                loaded={settingsLoaded}
                onRetry={loadSettings}
                options={options}
                recording={recording}
                onSave={async (s) => {
                    if (await changeSettings(s)) {
                        toast.success('設定を保存しました');
                    }
                }}
            />
            {/* 初めて開いたときの「はじめに」（#291）。デモ（?demo）ではホストがないので出さない */}
            {!isDemo && <SetupDialog />}
            <DevPanel />
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
