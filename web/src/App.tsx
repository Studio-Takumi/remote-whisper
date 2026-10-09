import { useState } from 'react';

import { toast } from 'sonner';

import { AppSidebar } from '@/components/AppSidebar';
import { MicButton } from '@/components/MicButton';
import { SettingsDialog } from '@/components/SettingsDialog';
import { StatusIndicator } from '@/components/StatusIndicator';
import { TopBar } from '@/components/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { defaultSettings } from '@/settings';

function App() {
    const [recording, setRecording] = useState(false);
    const [activeSession, setActiveSession] = useState('セッションA1');
    const [settings, setSettings] = useState(defaultSettings);
    const [settingsOpen, setSettingsOpen] = useState(false);

    return (
        <SidebarProvider>
            <AppSidebar
                recording={recording}
                activeSession={activeSession}
                onSelectSession={setActiveSession}
                onOpenSettings={() => setSettingsOpen(true)}
            />
            <SidebarInset className='gap-4 p-4'>
                <TopBar recording={recording} settings={settings} onChangeSettings={setSettings} />
                <Tabs defaultValue='transcript'>
                    <div className='flex justify-center'>
                        <TabsList>
                            <TabsTrigger value='transcript'>文字起こし</TabsTrigger>
                            <TabsTrigger value='summary'>要約</TabsTrigger>
                        </TabsList>
                    </div>
                    <TabsContent value='transcript' className='flex flex-col gap-2'>
                        <p>文字起こし</p>
                        <StatusIndicator recording={recording} />
                    </TabsContent>
                    <TabsContent value='summary'>要約</TabsContent>
                </Tabs>
                <MicButton recording={recording} onToggle={() => setRecording((r) => !r)} />
            </SidebarInset>
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
