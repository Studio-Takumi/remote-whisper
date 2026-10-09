import { StatusIndicator } from '@/components/StatusIndicator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { Session } from '@/mock';

// 選んだセッションの文字起こしと要約
export function SessionView({ session, recording }: { session: Session | undefined; recording: boolean }) {
    return (
        <Tabs defaultValue='transcript'>
            <div className='flex justify-center'>
                <TabsList>
                    <TabsTrigger value='transcript'>文字起こし</TabsTrigger>
                    <TabsTrigger value='summary'>要約</TabsTrigger>
                </TabsList>
            </div>
            <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 pt-4'>
                {session && (
                    <div>
                        <h1 className='text-lg font-semibold'>{session.title}</h1>
                        <p className='text-xs text-muted-foreground'>
                            {session.startedAt}
                            {session.status === 'interrupted' && '・途中で中断'}
                        </p>
                    </div>
                )}
                <TabsContent value='transcript' className='flex flex-col gap-2'>
                    {session?.transcript.map((line) => (
                        <div key={line.time} className='flex gap-3'>
                            <span className='shrink-0 font-mono text-xs leading-6 text-muted-foreground'>
                                {line.time}
                            </span>
                            <p className='leading-6'>{line.text}</p>
                        </div>
                    ))}
                    <StatusIndicator recording={recording} />
                </TabsContent>
                <TabsContent value='summary'>
                    {/* 本物は Markdown で届くので、後で Markdown として表示する */}
                    <p className='leading-6 whitespace-pre-wrap'>{session?.summary}</p>
                </TabsContent>
            </div>
        </Tabs>
    );
}
