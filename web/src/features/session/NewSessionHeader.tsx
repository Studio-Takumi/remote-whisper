import type { Project } from '@/api/types';
import { AudioDropZone, AudioUploadButton, MultiUploadDialog, UploadProgress } from '@/features/recording/AudioUpload';

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
