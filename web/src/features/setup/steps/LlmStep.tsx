import { useState } from 'react';

import { RefreshCwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { LLM_NAMES } from '@/features/settings/settings';
import { setupMessages } from '@/features/setup/i18n';
import type { SetupStatus } from '@/features/setup/setup';
import { LinkButton, Note, Step } from '@/features/setup/steps/StepParts';
import { useT } from '@/i18n/messages';

// 要約に使うアプリ（Ollama か LM Studio。設定で選んでいるほうだけ。#327）
export function LlmStep({
    status,
    ok,
    onRefresh,
}: {
    status: SetupStatus;
    ok: boolean;
    onRefresh: () => Promise<void>;
}) {
    const t = useT(setupMessages);
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
            {t('common.recheck')}
        </Button>
    );
    return (
        <Step title={name} purpose={t('llmStep.purpose')} ok={ok}>
            {ok ? (
                <Note>{lmstudio ? t('llmStep.serverRunning') : t('llmStep.running')}</Note>
            ) : llm.unauthorized ? (
                <>
                    <Note warn>{t('llmStep.unauthorized')}</Note>
                    <div className='flex flex-wrap gap-2'>{recheck}</div>
                </>
            ) : llm.found ? (
                <>
                    {lmstudio ? (
                        <Note warn>
                            {t('llmStep.lmStudioStart')}
                            <code className='font-mono'>lms server start</code>
                            {t('llmStep.lmStudioStartAfter')}
                        </Note>
                    ) : (
                        <Note warn>{t('llmStep.ollamaNotRunning')}</Note>
                    )}
                    <div className='flex flex-wrap gap-2'>{recheck}</div>
                </>
            ) : (
                <>
                    <Note warn>{t('llmStep.notInstalled')}</Note>
                    <div className='flex flex-wrap gap-2'>
                        <LinkButton href={llm.downloadUrl}>{t('llmStep.openDownloadPage')}</LinkButton>
                        {recheck}
                    </div>
                </>
            )}
        </Step>
    );
}
