import { useEffect } from 'react';

import type { Project } from '@/api/types';
import { useAppStore } from '@/app/store';
import { AudioDropZone, AudioUploadButton, MultiUploadDialog, UploadProgress } from '@/features/recording/AudioUpload';
import { sessionMessages } from '@/features/session/i18n';
import { TranscriptionLanguageSelect } from '@/features/settings/TranscriptionLanguageSelect';
import { useT } from '@/i18n/messages';

// 新しいセッションの画面の上。録音のほかに、音声ファイル（選ぶ・ドロップする）からも作れる（#180）
export function NewSessionHeader({ project }: { project: Project }) {
    const t = useT(sessionMessages);
    return (
        <AudioDropZone projectId={project.id}>
            <div className='flex flex-col gap-2'>
                <div>
                    <h1 className='text-lg font-semibold'>{t('newSessionHeader.title')}</h1>
                    <p className='text-xs text-muted-foreground'>
                        {t('newSessionHeader.recordTo', { name: project.name, path: project.path })}
                    </p>
                </div>
                <NextLanguage projectId={project.id} />
                <div className='flex flex-wrap items-center gap-2'>
                    <AudioUploadButton projectId={project.id} />
                    <p className='text-xs text-muted-foreground'>{t('newSessionHeader.dropHint')}</p>
                </div>
                <UploadProgress />
                <MultiUploadDialog />
            </div>
        </AudioDropZone>
    );
}

// 文字起こしの言語を今回だけ変える（#482）。全体設定は書き換えない。古いサーバー（言語を持たない）では出さない
function NextLanguage({ projectId }: { projectId: string }) {
    const t = useT(sessionMessages);
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
                {t('newSessionHeader.transcriptionLanguage')}
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
