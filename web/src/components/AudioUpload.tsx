import { type DragEvent, type ReactNode, useRef, useState } from 'react';

import { FileAudioIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store';
import { AUDIO_ACCEPT } from '@/upload';

// 音声ファイルから新しいセッションを作る（#180）。ファイルを選ぶボタン
export function AudioUploadButton({ projectId, compact = false }: { projectId: string; compact?: boolean }) {
    const input = useRef<HTMLInputElement>(null);
    const uploading = useAppStore((s) => s.uploading);
    const uploadAudio = useAppStore((s) => s.uploadAudio);
    const busy = uploading !== null;
    const label = '音声ファイルから作る';

    const picker = (
        <input
            ref={input}
            type='file'
            accept={AUDIO_ACCEPT}
            className='hidden'
            onChange={(e) => {
                const file = e.target.files?.[0];
                // 同じファイルをもう一度選べるように、選んだものは消しておく
                e.target.value = '';
                if (file) {
                    void uploadAudio(projectId, file);
                }
            }}
        />
    );

    if (compact) {
        // サイドバーのプロジェクトの行（＋の隣）に置く小さいボタン
        return (
            <>
                {picker}
                <button
                    className='flex size-6 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:opacity-50'
                    aria-label={label}
                    title={label}
                    disabled={busy}
                    onClick={() => input.current?.click()}
                >
                    <FileAudioIcon size={15} />
                </button>
            </>
        );
    }
    return (
        <>
            {picker}
            <Button variant='outline' size='sm' disabled={busy} onClick={() => input.current?.click()}>
                <FileAudioIcon />
                {label}
            </Button>
        </>
    );
}

// アップロードの進み具合（%）
export function UploadProgress() {
    const uploading = useAppStore((s) => s.uploading);
    if (!uploading) {
        return null;
    }
    return (
        <div className='flex flex-col gap-1' role='status'>
            <p className='text-xs text-muted-foreground'>
                {uploading.name} をアップロードしています… {uploading.percent}%
            </p>
            <div className='h-1.5 w-full overflow-hidden rounded-full bg-muted'>
                <div className='h-full bg-primary transition-[width]' style={{ width: `${uploading.percent}%` }} />
            </div>
        </div>
    );
}

// 音声ファイルをドロップして、新しいセッションを作れる場所（新しいセッションの画面）
export function AudioDropZone({ projectId, children }: { projectId: string; children: ReactNode }) {
    const uploadAudio = useAppStore((s) => s.uploadAudio);
    const [over, setOver] = useState(false);
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

    return (
        <div
            className={`rounded-lg transition-colors ${over ? 'bg-accent outline-2 outline-primary outline-dashed' : ''}`}
            onDragOver={(e) => {
                if (hasFiles(e)) {
                    e.preventDefault();
                    setOver(true);
                }
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => {
                if (!hasFiles(e)) {
                    return;
                }
                e.preventDefault();
                setOver(false);
                const file = e.dataTransfer.files[0];
                if (file) {
                    void uploadAudio(projectId, file);
                }
            }}
        >
            {children}
        </div>
    );
}
