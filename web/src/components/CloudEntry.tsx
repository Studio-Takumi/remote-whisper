// クラウド版の入口（#156）。中身の画面はまだなく、何が入るかだけを出す
import { useCloudStore } from '@/cloud';
import type { CloudStage } from '@/cloud';

const PLACEHOLDERS: Record<CloudStage, { title: string; body: string }> = {
    login: { title: 'ログイン', body: 'Google・Discord・GitHub のどれかでログインする画面が入ります（#155）。' },
    consent: {
        title: '利用規約への同意',
        body: '初めて使うときに、利用規約とプライバシーポリシーに同意する画面が入ります（#162）。',
    },
    hosts: { title: 'ホストの選択', body: '使うホスト（文字起こしをするマシン）を選ぶ画面が入ります（#161）。' },
    ready: { title: 'ホストにつながっています', body: '' },
};

export function CloudEntry() {
    const stage = useCloudStore((s) => s.cloud.stage);
    const { title, body } = PLACEHOLDERS[stage];
    return (
        <main className='mx-auto flex min-h-svh max-w-md flex-col justify-center gap-3 p-6' data-cloud-stage={stage}>
            <p className='text-xs text-muted-foreground'>Remote Whisper（クラウド版・準備中）</p>
            <h1 className='text-xl font-semibold'>{title}</h1>
            <p className='text-sm'>{body}</p>
        </main>
    );
}
