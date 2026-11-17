import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';

import { api } from '@/api/api';
import { Button } from '@/components/ui/button';
import { PHASE_LABELS, type SetupStatus, formatElapsed } from '@/features/setup/setup';
import { Note, Step } from '@/features/setup/steps/StepParts';

export function WhisperXStep({
    status,
    ok,
    locked,
    act,
    onRefresh,
}: {
    status: SetupStatus;
    ok: boolean;
    locked: boolean;
    act: (call: () => Promise<SetupStatus>) => Promise<void>;
    onRefresh: () => Promise<void>;
}) {
    const w = status.whisperx;
    const job = w.install;
    const running = job?.state === 'running';

    let body: React.ReactNode;
    if (w.installed) {
        body = <Note>入っています</Note>;
    } else if (running && job) {
        body = (
            <div className='flex flex-col gap-2'>
                <Note>
                    <LoaderCircleIcon className='mr-1 inline size-3 animate-spin align-[-2px]' />
                    {PHASE_LABELS[job.phase]}
                    {job.package && `：${job.package}`}（経過 {formatElapsed(job.elapsedSec)}）
                </Note>
                {job.phase !== 'rollingBack' && (
                    <div>
                        <Button
                            variant='outline'
                            size='sm'
                            disabled={locked}
                            onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/whisperx'))}
                        >
                            やめる
                        </Button>
                    </div>
                )}
            </div>
        );
    } else if (w.installable) {
        body = (
            <>
                {job?.state === 'failed' &&
                    (job.rollbackFailed ? (
                        <Note warn>
                            入れられず、元にも戻せませんでした。インストーラで入れ直してください（ログはデータのフォルダの
                            log/whisperx-install.log）
                        </Note>
                    ) : (
                        <Note warn>
                            入れられなかったため、元に戻しました（ログはデータのフォルダの log/whisperx-install.log）
                        </Note>
                    ))}
                {job?.state === 'cancelled' && <Note>やめて、元に戻しました</Note>}
                <Note>
                    約 {w.downloadGb} GB をダウンロードし、ディスクを約 {w.diskGb} GB 使います。{w.minutes[0]}〜
                    {w.minutes[1]} 分かかります
                </Note>
                <div className='flex flex-wrap items-center gap-2'>
                    <Button
                        size='sm'
                        disabled={locked || status.recording}
                        onClick={() => void act(() => api.post<SetupStatus>('/api/setup/whisperx'))}
                    >
                        <DownloadIcon />
                        入れる
                    </Button>
                    {status.recording && <Note warn>録音が終わってから入れられます</Note>}
                </div>
            </>
        );
    } else if (status.runtime !== 'dev') {
        // 固定した依存の一覧を同梱していない古い配布版: 画面からは入れない
        body = <Note warn>この版では画面から入れられません。新しい版のインストーラを入れてください</Note>;
    } else {
        // 開発の環境（uv）: 案内だけ
        body = (
            <>
                <Note>開発の環境では、server のフォルダで次のコマンドを実行してください</Note>
                <code className='w-fit rounded bg-muted px-2 py-1 font-mono text-xs'>
                    {w.command ?? 'uv sync --extra final'}
                </code>
                <div>
                    <Button variant='outline' size='sm' onClick={() => void onRefresh()}>
                        <RefreshCwIcon />
                        もう一度確かめる
                    </Button>
                </div>
            </>
        );
    }
    return (
        <Step title='WhisperX' purpose='浄書と話者分けに使うライブラリ' ok={ok || w.installed}>
            {body}
        </Step>
    );
}
