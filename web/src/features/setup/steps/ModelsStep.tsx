import { DownloadIcon } from 'lucide-react';

import { api } from '@/api/api';
import { Button } from '@/components/ui/button';
import { LLM_NAMES, recommendedLmStudioModels } from '@/features/settings/settings';
import { type SetupStatus, formatGb, missingModels, missingSizeGb, pullPercent } from '@/features/setup/setup';
import { Note, ProgressBar, Step } from '@/features/setup/steps/StepParts';

export function ModelsStep({
    status,
    ok,
    locked,
    act,
}: {
    status: SetupStatus;
    ok: boolean;
    locked: boolean;
    act: (call: () => Promise<SetupStatus>) => Promise<void>;
}) {
    const llm = status.llm;
    const name = LLM_NAMES[llm.backend];
    const pull = llm.pull;
    const pulling = pull?.state === 'running';
    const missing = missingModels(status);
    const sizeGb = missingSizeGb(status);
    // 大きさが分からないもの（LM Studio の一部）があれば「以上」を付ける
    const sizeUnknown = missing.some((m) => m.sizeGb === null);
    // 押せない理由
    const reason = !llm.running
        ? `${name} が動いてから取得できます`
        : status.recording
          ? '録音が終わってから取得できます'
          : null;

    return (
        <Step title='要約のモデル' purpose={`要約などに使う ${name} のモデル`} ok={ok}>
            {llm.backend === 'lmstudio' && (
                <Note>
                    録音中は {recommendedLmStudioModels.liveSummary}{' '}
                    を使います。入っていないと大きいモデルで代わりに動くため、VRAM が 6GB ほどの GPU
                    では文字起こしが遅くなります
                </Note>
            )}
            <ul className='flex flex-col gap-1'>
                {llm.models.map((m) => (
                    <li key={m.name} className='flex items-center justify-between gap-2 text-xs'>
                        <span className='font-mono'>{m.name}</span>
                        <span className='flex shrink-0 items-center gap-3 whitespace-nowrap text-muted-foreground'>
                            {m.sizeGb !== null && <span>{m.sizeGb.toFixed(1)} GB</span>}
                            <span
                                className={
                                    m.installed
                                        ? 'min-w-[6.5em] text-right text-emerald-700 dark:text-emerald-400'
                                        : 'min-w-[6.5em] text-right text-amber-700 dark:text-amber-400'
                                }
                            >
                                {m.installed ? '入っています' : '入っていません'}
                            </span>
                        </span>
                    </li>
                ))}
            </ul>
            {pulling && pull ? (
                <div className='flex flex-col gap-1'>
                    <Note>
                        {pull.backend !== llm.backend && `${LLM_NAMES[pull.backend]} で `}
                        {pull.model} を取得中（{pull.index + 1}/{pull.models.length}）
                        {pull.total > 0 &&
                            `・${pullPercent(pull)}%（${formatGb(pull.completed)} / ${formatGb(pull.total)}）`}
                    </Note>
                    <ProgressBar percent={pullPercent(pull)} label={`${pull.model} の取得`} />
                    {/* 取っている途中に切り替えたときも、始めたほうで決める（LM Studio は止められない） */}
                    {pull.backend !== 'lmstudio' ? (
                        <div>
                            <Button
                                variant='outline'
                                size='sm'
                                disabled={locked}
                                onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/llm/pull'))}
                            >
                                やめる
                            </Button>
                        </div>
                    ) : (
                        // LM Studio には取得を止める API がない（#327）
                        <Note>止めるときは LM Studio の画面から止めてください</Note>
                    )}
                </div>
            ) : (
                <>
                    {pull?.state === 'failed' && <Note warn>{pull.error ?? '取得できませんでした'}</Note>}
                    {pull?.state === 'cancelled' && <Note>取得をやめました</Note>}
                    {missing.length > 0 && (
                        <div className='flex flex-wrap items-center gap-2'>
                            <Button
                                size='sm'
                                disabled={locked || reason !== null}
                                onClick={() =>
                                    void act(() =>
                                        api.post<SetupStatus>('/api/setup/llm/pull', {
                                            models: missing.map((m) => m.name),
                                        }),
                                    )
                                }
                            >
                                <DownloadIcon />
                                {sizeGb > 0 ? `取得（約 ${sizeGb} GB${sizeUnknown ? ' 以上' : ''}）` : '取得'}
                            </Button>
                            {reason && <Note warn>{reason}</Note>}
                        </div>
                    )}
                </>
            )}
        </Step>
    );
}
