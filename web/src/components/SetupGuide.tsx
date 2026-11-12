import { useState } from 'react';

import {
    CircleAlertIcon,
    CircleCheckIcon,
    CpuIcon,
    DownloadIcon,
    ExternalLinkIcon,
    LoaderCircleIcon,
    RefreshCwIcon,
} from 'lucide-react';
import { toast } from 'sonner';

import { api } from '@/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LLM_NAMES, recommendedLmStudioModels } from '@/settings';
import {
    DIARIZATION_MODEL_URL,
    HF_TOKENS_URL,
    PHASE_LABELS,
    type SetupStatus,
    type WhisperFlags,
    formatElapsed,
    formatGb,
    missingModels,
    missingSizeGb,
    missingSteps,
    pullPercent,
} from '@/setup';

// 足りないものを順に並べる（設定の「セットアップ」と、初回の「はじめに」で同じもの）
export function SetupGuide({
    status,
    onStatus,
    onRefresh,
    settings,
}: {
    status: SetupStatus;
    onStatus: (status: SetupStatus) => void;
    onRefresh: () => Promise<void>;
    settings: WhisperFlags;
}) {
    const missing = missingSteps(status, settings);
    // クラウド版（トンネル）からは見るだけ
    const locked = status.remote;

    async function act(call: () => Promise<SetupStatus>) {
        try {
            onStatus(await call());
        } catch (e) {
            toast.error(e instanceof Error ? e.message : 'できませんでした');
            void onRefresh();
        }
    }

    return (
        <div className='flex flex-col gap-3'>
            {locked ? (
                <p className='rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300'>
                    クラウド版からは見るだけです。ホストで直接開いた画面から操作してください
                </p>
            ) : (
                <p className='text-xs text-muted-foreground'>
                    どれも飛ばせます（文字起こしはそのまま使えます）。ボタンを押した時点で実行します
                </p>
            )}
            {status.gpu === 'none' && <GpuStep />}
            <LlmStep status={status} ok={!missing.llm} onRefresh={onRefresh} />
            <ModelsStep status={status} ok={!missing.models} locked={locked} act={act} />
            <WhisperXStep status={status} ok={!missing.whisperx} locked={locked} act={act} onRefresh={onRefresh} />
            <TokenStep status={status} ok={status.hfToken.source !== null} locked={locked} act={act} />
        </div>
    );
}

function Step({
    title,
    purpose,
    ok,
    icon,
    children,
}: {
    title: string;
    purpose: string;
    ok?: boolean;
    icon?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className='flex flex-col gap-2 rounded-lg border p-3'>
            <div className='flex flex-wrap items-center gap-x-2 gap-y-0.5'>
                {icon ??
                    (ok ? (
                        <CircleCheckIcon
                            className='size-4 shrink-0 text-emerald-600 dark:text-emerald-400'
                            aria-label='そろっています'
                        />
                    ) : (
                        <CircleAlertIcon
                            className='size-4 shrink-0 text-amber-600 dark:text-amber-400'
                            aria-label='足りません'
                        />
                    ))}
                <h3 className='text-sm font-semibold'>{title}</h3>
                <span className='text-xs text-muted-foreground'>{purpose}</span>
            </div>
            <div className='flex flex-col gap-2 text-sm'>{children}</div>
        </section>
    );
}

function Note({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
    return (
        <p className={warn ? 'text-xs text-amber-700 dark:text-amber-400' : 'text-xs text-muted-foreground'}>
            {children}
        </p>
    );
}

function LinkButton({ href, children }: { href: string; children: React.ReactNode }) {
    return (
        <Button variant='outline' size='sm' asChild>
            <a href={href} target='_blank' rel='noreferrer noopener'>
                {children}
                <ExternalLinkIcon />
            </a>
        </Button>
    );
}

function ProgressBar({ percent, label }: { percent: number; label: string }) {
    return (
        <div
            className='h-2 w-full overflow-hidden rounded-full bg-muted'
            role='progressbar'
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
        >
            <div className='h-full bg-primary transition-[width]' style={{ width: `${percent}%` }} />
        </div>
    );
}

function GpuStep() {
    return (
        <Step
            title='GPU'
            purpose='文字起こしを速くするためのもの'
            icon={<CpuIcon className='size-4 shrink-0 text-muted-foreground' />}
        >
            <Note>
                GPU が見つからないため、文字起こしは CPU で動きます。GPU
                より数倍以上遅くなり、文字が出るまで時間がかかります。モデルを small
                などの小さいものにすると速くなります
            </Note>
        </Step>
    );
}

// 要約に使うアプリ（Ollama か LM Studio。設定で選んでいるほうだけ。#327）
function LlmStep({ status, ok, onRefresh }: { status: SetupStatus; ok: boolean; onRefresh: () => Promise<void> }) {
    const llm = status.llm;
    const lmstudio = llm.backend === 'lmstudio';
    const name = LLM_NAMES[llm.backend];
    const [checking, setChecking] = useState(false);

    async function check() {
        setChecking(true);
        try {
            await onRefresh();
        } finally {
            setChecking(false);
        }
    }

    const recheck = (
        <Button variant='outline' size='sm' disabled={checking} onClick={() => void check()}>
            <RefreshCwIcon className={checking ? 'animate-spin' : undefined} />
            もう一度確かめる
        </Button>
    );
    return (
        <Step title={name} purpose='要約と用語リストを作るアプリ' ok={ok}>
            {ok ? (
                <Note>{lmstudio ? 'サーバーが動いています' : '動いています'}</Note>
            ) : llm.unauthorized ? (
                <>
                    <Note warn>LM Studio のトークンが違うため接続できません。設定の「要約」で確かめてください</Note>
                    <div className='flex flex-wrap gap-2'>{recheck}</div>
                </>
            ) : llm.found ? (
                <>
                    {lmstudio ? (
                        <Note warn>
                            LM Studio のサーバーを起動してください。LM Studio の「Developer」でサーバーをオンにするか、
                            <code className='font-mono'>lms server start</code> を実行します
                        </Note>
                    ) : (
                        <Note warn>Ollama が起動していません。起動してから確かめてください</Note>
                    )}
                    <div className='flex flex-wrap gap-2'>{recheck}</div>
                </>
            ) : (
                <>
                    <Note warn>入っていないため、要約と用語リストは作られません</Note>
                    <div className='flex flex-wrap gap-2'>
                        <LinkButton href={llm.downloadUrl}>ダウンロードのページを開く</LinkButton>
                        {recheck}
                    </div>
                </>
            )}
        </Step>
    );
}

function ModelsStep({
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

function WhisperXStep({
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

function TokenStep({
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
    const [token, setToken] = useState('');
    const source = status.hfToken.source;

    async function save() {
        // 送ったらすぐ入力欄を空にする（画面にトークンを残さない）
        const value = token.trim();
        setToken('');
        await act(() => api.put<SetupStatus>('/api/setup/hf-token', { token: value }));
    }

    return (
        <Step title='HuggingFace のトークン' purpose='話者分けのモデルを取るためのもの' ok={ok}>
            {source === 'env' && <Note>環境変数 HF_TOKEN のトークンを使っています</Note>}
            {source === 'login' && <Note>hf auth login で保存したトークンを使っています</Note>}
            {source === 'file' ? (
                <div className='flex flex-wrap items-center gap-2'>
                    <Note>保存済み</Note>
                    <Button
                        variant='outline'
                        size='sm'
                        disabled={locked}
                        onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/hf-token'))}
                    >
                        削除
                    </Button>
                </div>
            ) : (
                <>
                    <ol className='flex list-decimal flex-col gap-1 pl-5 text-xs text-muted-foreground'>
                        <li>
                            <a
                                className='underline'
                                href={DIARIZATION_MODEL_URL}
                                target='_blank'
                                rel='noreferrer noopener'
                            >
                                話者分けのモデルのページ
                            </a>
                            で、ログインして利用条件に同意します
                        </li>
                        <li>
                            <a className='underline' href={HF_TOKENS_URL} target='_blank' rel='noreferrer noopener'>
                                アクセストークンのページ
                            </a>
                            で Read のトークンを作り、下に貼ります
                        </li>
                    </ol>
                    <form
                        className='flex flex-wrap items-center gap-2'
                        onSubmit={(e) => {
                            e.preventDefault();
                            void save();
                        }}
                    >
                        <Input
                            type='password'
                            autoComplete='off'
                            spellCheck={false}
                            aria-label='HuggingFace のトークン'
                            placeholder='hf_…'
                            className='w-56'
                            value={token}
                            disabled={locked}
                            onChange={(e) => setToken(e.target.value)}
                        />
                        <Button type='submit' size='sm' disabled={locked || token.trim() === ''}>
                            保存
                        </Button>
                    </form>
                </>
            )}
        </Step>
    );
}
