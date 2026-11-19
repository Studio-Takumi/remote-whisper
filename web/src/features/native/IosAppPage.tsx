// 設定モーダルの「iOS アプリ」ページ（#438。spec/mobile.md 11.4）。iOS アプリの中で開いたときだけ出す検証用の操作。
// 録音のプラグイン（@capacitor/core を使う）は、開いたときに別のチャンク（nativeBridge）から読み込む
import { useEffect, useState } from 'react';

import { CircleIcon, FileAudioIcon, SquareIcon, Trash2Icon } from 'lucide-react';

import { useCurrentProject } from '@/app/sessionHooks';
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
import { loadRecorder } from '@/features/native/nativePlatform';
import type { RecorderPlugin, RecorderReason, RecorderState, RecordingFile } from '@/features/native/recorderTypes';
import { readRecordingFile } from '@/features/native/recordingFile';
import { recorderErrorMessage, useRecorder } from '@/features/native/useRecorder';
import { Section } from '@/features/settings/SettingsParts';
import { displayTime, formatElapsed } from '@/lib/time';

const STATE_LABELS: Record<RecorderState, string> = {
    idle: '停止中',
    recording: '録音中',
    interrupted: '割り込み中',
};

const REASON_LABELS: Record<RecorderReason, string> = {
    user: '操作',
    interruption: '割り込み（電話・Siri など）',
    resumed: '割り込みのあとに再開',
    interruptionEnded: '割り込みのあとに再開できず停止',
    routeChange: '入力の切り替え',
    mediaServicesReset: 'メディアサービスのリセット',
    error: 'エラー',
};

function formatSize(bytes: number) {
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

// 録音ファイルを削除する前の確認（ほかの画面と同じ Dialog の部品。MultiUploadDialog と同じ並び）
function DeleteRecordingDialog({
    name,
    onCancel,
    onDelete,
}: {
    name: string | null;
    onCancel: () => void;
    onDelete: (name: string) => void;
}) {
    return (
        <Dialog open={name !== null} onOpenChange={(open) => !open && onCancel()}>
            <DialogContent className='sm:max-w-md'>
                <DialogHeader>
                    <DialogTitle>録音ファイルを削除</DialogTitle>
                    <DialogDescription className='break-all'>{name} を削除します。元に戻せません</DialogDescription>
                </DialogHeader>
                <DialogFooter className='gap-2'>
                    <Button variant='outline' onClick={onCancel}>
                        キャンセル
                    </Button>
                    <Button variant='destructive' onClick={() => name && onDelete(name)}>
                        <Trash2Icon />
                        削除
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export function IosAppPage() {
    const [recorder, setRecorder] = useState<{ plugin: RecorderPlugin } | null>(null);
    const [error, setError] = useState<string | null>(null);
    useEffect(() => {
        let active = true;
        loadRecorder()
            .then((r) => active && setRecorder(r))
            .catch((e: unknown) => active && setError(recorderErrorMessage(e)));
        return () => {
            active = false;
        };
    }, []);
    if (!recorder) {
        return <p className='text-xs text-muted-foreground'>{error ?? '読み込んでいます…'}</p>;
    }
    return <IosRecorderPanel plugin={recorder.plugin} />;
}

export function IosRecorderPanel({ plugin }: { plugin: RecorderPlugin }) {
    const { view, start, stop, remove, setError } = useRecorder(plugin);
    const project = useCurrentProject();
    const uploading = useAppStore((s) => s.uploading);
    const uploadAudio = useAppStore((s) => s.uploadAudio);
    // 録ったファイルを読み込んでいる間（readRecording で分けて読む）
    const [reading, setReading] = useState<{ name: string; percent: number } | null>(null);
    const busy = reading !== null || uploading !== null;
    // 削除を確かめているファイル
    const [deleting, setDeleting] = useState<string | null>(null);
    const active = view.state !== 'idle';

    // 録ったファイルを「音声ファイルから作る」（spec/flows.md 6.11）と同じ処理に渡す。入れる先は今開いているプロジェクト
    const createSession = async (file: RecordingFile) => {
        if (!project) {
            return;
        }
        setError(null);
        setReading({ name: file.name, percent: 0 });
        let picked: File;
        try {
            picked = await readRecordingFile(plugin, file, (percent) => setReading({ name: file.name, percent }));
        } catch (e) {
            setError(recorderErrorMessage(e));
            return;
        } finally {
            setReading(null);
        }
        await uploadAudio(project.id, picked);
    };

    return (
        <div className='flex flex-col'>
            <Section title='録音' description='バックグラウンドで録音できるかの検証用です'>
                <div className='flex flex-col gap-3 py-3'>
                    <dl className='grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm'>
                        <dt className='text-muted-foreground'>状態</dt>
                        <dd data-testid='recorder-state'>{STATE_LABELS[view.state]}</dd>
                        <dt className='text-muted-foreground'>経過時間</dt>
                        <dd className='tabular-nums' data-testid='recorder-seconds'>
                            {formatElapsed(Math.floor(view.seconds))}
                        </dd>
                        <dt className='text-muted-foreground'>理由</dt>
                        <dd data-testid='recorder-reason'>{view.reason ? REASON_LABELS[view.reason] : '—'}</dd>
                    </dl>
                    <div className='flex gap-2'>
                        <Button size='sm' disabled={active} onClick={() => void start()}>
                            <CircleIcon />
                            録音開始
                        </Button>
                        <Button size='sm' variant='outline' disabled={!active} onClick={() => void stop()}>
                            <SquareIcon />
                            録音停止
                        </Button>
                    </div>
                    {view.error && (
                        <p className='text-xs text-destructive' role='alert'>
                            {view.error}
                        </p>
                    )}
                </div>
            </Section>
            <Section
                title='録音ファイル'
                description={
                    project ? `${project.name} にセッションを作ります` : 'プロジェクトを開くとセッションを作れます'
                }
            >
                {reading && (
                    <p className='py-2 text-xs text-muted-foreground' role='status'>
                        {reading.name} を読み込んでいます… {reading.percent}%
                    </p>
                )}
                {uploading && (
                    <p className='py-2 text-xs text-muted-foreground' role='status'>
                        {uploading.name} をアップロードしています… {uploading.percent}%
                    </p>
                )}
                {view.files.length === 0 ? (
                    <p className='py-3 text-xs text-muted-foreground'>録音ファイルはありません</p>
                ) : (
                    view.files.map((f) => {
                        const recordingThis = active && view.file === f.name;
                        return (
                            <div key={f.name} className='flex flex-col gap-2 py-3' data-testid='recording-file'>
                                <div className='flex flex-col gap-0.5'>
                                    <p className='text-sm break-all'>{f.name}</p>
                                    <p className='text-xs text-muted-foreground tabular-nums'>
                                        {formatElapsed(Math.floor(f.durationSec))} ・ {formatSize(f.size)} ・{' '}
                                        {displayTime(f.createdAt)}
                                        {recordingThis && ' ・ 録音中'}
                                    </p>
                                </div>
                                <div className='flex gap-2'>
                                    <Button
                                        size='sm'
                                        variant='outline'
                                        disabled={!project || busy || recordingThis}
                                        onClick={() => void createSession(f)}
                                    >
                                        <FileAudioIcon />
                                        セッションを作る
                                    </Button>
                                    <Button
                                        size='sm'
                                        variant='ghost'
                                        disabled={busy || recordingThis}
                                        aria-label={`${f.name} を削除`}
                                        onClick={() => setDeleting(f.name)}
                                    >
                                        <Trash2Icon />
                                        削除
                                    </Button>
                                </div>
                            </div>
                        );
                    })
                )}
            </Section>
            <DeleteRecordingDialog
                name={deleting}
                onCancel={() => setDeleting(null)}
                onDelete={(name) => {
                    setDeleting(null);
                    void remove(name);
                }}
            />
        </div>
    );
}
