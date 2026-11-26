import { useEffect } from 'react';

import type { Project } from '@/api/types';
import { useAppStore } from '@/app/store';
import { AudioDropZone, AudioUploadButton, MultiUploadDialog, UploadProgress } from '@/features/recording/AudioUpload';
import { TranscriptionLanguageSelect } from '@/features/settings/TranscriptionLanguageSelect';

// 新しいセッションの画面の上。録音のほかに、音声ファイル（選ぶ・ドロップする）からも作れる（#180）
export function NewSessionHeader({ project }: { project: Project }) {
    return (
        <AudioDropZone projectId={project.id}>
            <div className='flex flex-col gap-2'>
                <div>
                    <h1 className='text-lg font-semibold'>新しいセッション</h1>
                    <p className='text-xs text-muted-foreground'>
                        {project.name}（{project.path}）に録音します
                    </p>
                </div>
                <NextLanguage projectId={project.id} />
                <div className='flex flex-wrap items-center gap-2'>
                    <AudioUploadButton projectId={project.id} />
                    <p className='text-xs text-muted-foreground'>
                        音声ファイル（wav・mp3・m4a など）をドロップしても作れます
                    </p>
                </div>
                <UploadProgress />
                <MultiUploadDialog />
            </div>
        </AudioDropZone>
    );
}

// 文字起こしの言語を今回だけ変える（#482）。全体設定は書き換えない。古いサーバー（言語を持たない）では出さない
function NextLanguage({ projectId }: { projectId: string }) {
    const saved = useAppStore((s) => s.settings.whisper.language);
    const next = useAppStore((s) => s.nextLanguage);
    const setNext = useAppStore((s) => s.setNextLanguage);
    // 新規セッション画面を離れたら（録音を始めた・ほかを開いた）、全体設定に戻す
    useEffect(() => () => setNext(null), [projectId, setNext]);
    if (saved === undefined) {
        return null;
    }
    return (
        <div className='flex items-center gap-2'>
            <label htmlFor='next-language' className='text-xs text-muted-foreground'>
                文字起こしの言語
            </label>
            <TranscriptionLanguageSelect
                id='next-language'
                size='sm'
                value={next ?? saved}
                // 全体設定と同じに戻したら、今回だけの値は持たない
                onChange={(value) => setNext(value === saved ? null : value)}
            />
        </div>
    );
}
