import { type DragEvent, type ReactNode, useRef, useState } from 'react';

import { FileAudioIcon } from 'lucide-react';

import { useAppStore } from '@/app/store';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { recordingMessages } from '@/features/recording/i18n';
import { AUDIO_ACCEPT } from '@/features/recording/upload';
import { mergeUnavailable } from '@/features/session/sources';
import { useT } from '@/i18n/messages';

// 音声ファイルから新しいセッションを作る（#180）。ファイルを選ぶボタン。
// 複数のファイルを選んだら、まとめるか別々にするかを選ぶ（#357。MultiUploadDialog）
export function AudioUploadButton({ projectId }: { projectId: string }) {
    const input = useRef<HTMLInputElement>(null);
    const uploading = useAppStore((s) => s.uploading);
    const pickAudioFiles = useAppStore((s) => s.pickAudioFiles);
    const busy = uploading !== null;
    const t = useT(recordingMessages);
    const label = t('audioUpload.label');

    const picker = (
        <input
            ref={input}
            type='file'
            accept={AUDIO_ACCEPT}
            multiple
            className='hidden'
            onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                // 同じファイルをもう一度選べるように、選んだものは消しておく
                e.target.value = '';
                pickAudioFiles(projectId, files);
            }}
        />
    );

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
    const t = useT(recordingMessages);
    const uploading = useAppStore((s) => s.uploading);
    if (!uploading) {
        return null;
    }
    return (
        <div className='flex flex-col gap-1' role='status'>
            <p className='text-xs text-muted-foreground'>
                {t('audioUpload.uploading', { name: uploading.name, percent: uploading.percent })}
            </p>
            <div className='h-1.5 w-full overflow-hidden rounded-full bg-muted'>
                <div className='h-full bg-primary transition-[width]' style={{ width: `${uploading.percent}%` }} />
            </div>
        </div>
    );
}

// 音声ファイルをドロップして、新しいセッションを作れる場所（新しいセッションの画面）
export function AudioDropZone({ projectId, children }: { projectId: string; children: ReactNode }) {
    const pickAudioFiles = useAppStore((s) => s.pickAudioFiles);
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
                pickAudioFiles(projectId, Array.from(e.dataTransfer.files));
            }}
        >
            {children}
        </div>
    );
}

// 複数のファイルを選んだ（ドロップした）とき、1 つのセッションにまとめるか、別々のセッションにするかを選ぶ
// （#241・#357。spec/ui.md 8 の「複数のファイルから作る」）。まとめるときは主の音源にするファイルを選ぶ（既定は 1 つ目）
export function MultiUploadDialog() {
    const t = useT(recordingMessages);
    const picked = useAppStore((s) => s.pickedAudio);
    const maxSources = useAppStore((s) => s.options.recording?.maxSources);
    const cancel = useAppStore((s) => s.cancelPickedAudio);
    const uploadSeparately = useAppStore((s) => s.uploadSeparately);
    const uploadSources = useAppStore((s) => s.uploadSources);
    const files = picked?.files ?? [];
    const unavailable = mergeUnavailable(files.length, maxSources);
    const [choice, setChoice] = useState<{ files: File[]; merge: boolean; main: number } | null>(null);
    // 選び直したら既定（まとめられるならまとめる・主の音源は 1 つ目）に戻す
    const current = choice?.files === files ? choice : { files, merge: unavailable === null, main: 0 };
    const merge = current.merge && unavailable === null;
    const update = (next: Partial<{ merge: boolean; main: number }>) => setChoice({ ...current, ...next });

    return (
        <Dialog open={picked !== null} onOpenChange={(open) => !open && cancel()}>
            <DialogContent className='sm:max-w-md'>
                <DialogHeader>
                    <DialogTitle>{t('audioUpload.dialogTitle', { n: files.length })}</DialogTitle>
                    <DialogDescription>{t('audioUpload.dialogDescription')}</DialogDescription>
                </DialogHeader>
                <fieldset className='flex flex-col gap-3'>
                    <legend className='sr-only'>{t('audioUpload.way')}</legend>
                    <label className='flex items-start gap-2 text-sm has-disabled:opacity-50'>
                        <input
                            type='radio'
                            name='multi-upload'
                            className='mt-1'
                            checked={merge}
                            disabled={unavailable !== null}
                            onChange={() => update({ merge: true })}
                        />
                        <span className='flex flex-col'>
                            {t('audioUpload.merge')}
                            <span className='text-xs text-muted-foreground'>
                                {unavailable ?? t('audioUpload.mergeHint')}
                            </span>
                        </span>
                    </label>
                    {merge && (
                        <label className='ml-6 flex flex-col gap-1 text-xs text-muted-foreground'>
                            {t('audioUpload.primarySource')}
                            <Select value={String(current.main)} onValueChange={(v) => update({ main: Number(v) })}>
                                <SelectTrigger
                                    size='sm'
                                    className='w-full text-xs'
                                    aria-label={t('audioUpload.primarySource')}
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {files.map((f, i) => (
                                        <SelectItem key={`${f.name}-${i}`} value={String(i)} className='text-xs'>
                                            {f.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </label>
                    )}
                    <label className='flex items-start gap-2 text-sm'>
                        <input
                            type='radio'
                            name='multi-upload'
                            className='mt-1'
                            checked={!merge}
                            onChange={() => update({ merge: false })}
                        />
                        <span className='flex flex-col'>
                            {t('audioUpload.separate')}
                            <span className='text-xs text-muted-foreground'>{t('audioUpload.separateHint')}</span>
                        </span>
                    </label>
                </fieldset>
                <DialogFooter className='gap-2'>
                    <Button variant='outline' onClick={cancel}>
                        {t('audioUpload.cancel')}
                    </Button>
                    <Button onClick={() => void (merge ? uploadSources(current.main) : uploadSeparately())}>
                        <FileAudioIcon />
                        {t('audioUpload.create')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
