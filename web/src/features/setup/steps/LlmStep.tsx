import { useState } from 'react';

import { RefreshCwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { LLM_NAMES } from '@/features/settings/settings';
import type { SetupStatus } from '@/features/setup/setup';
import { LinkButton, Note, Step } from '@/features/setup/steps/StepParts';

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
