import { useState } from 'react';

import { AppSidebar } from '@/components/AppSidebar';
import { MicButton } from '@/components/MicButton';
import { TopBar } from '@/components/TopBar';
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { Toaster } from '@/components/ui/sonner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

function App() {
    const [recording, setRecording] = useState(false);
    const [activeSession, setActiveSession] = useState('セッションA1');

    return (
        <SidebarProvider>
            <AppSidebar recording={recording} activeSession={activeSession} onSelectSession={setActiveSession} />
            <SidebarInset className='gap-4 p-4'>
                <TopBar recording={recording} />
                <Tabs defaultValue='transcript'>
                    <div className='flex justify-center'>
                        <TabsList>
                            <TabsTrigger value='transcript'>文字起こし</TabsTrigger>
                            <TabsTrigger value='summary'>要約</TabsTrigger>
                        </TabsList>
                    </div>
                    <TabsContent value='transcript'>文字起こし</TabsContent>
                    <TabsContent value='summary'>要約</TabsContent>
                </Tabs>
                <MicButton recording={recording} onToggle={() => setRecording((r) => !r)} />
            </SidebarInset>
            <Toaster />
        </SidebarProvider>
    );
}

export default App;
