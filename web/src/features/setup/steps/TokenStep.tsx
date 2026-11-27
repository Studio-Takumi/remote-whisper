import { useState } from 'react';

import { api } from '@/api/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { setupMessages } from '@/features/setup/i18n';
import { DIARIZATION_MODEL_URL, HF_TOKENS_URL, type SetupStatus } from '@/features/setup/setup';
import { Note, Step } from '@/features/setup/steps/StepParts';
import { useT } from '@/i18n/messages';

export function TokenStep({
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
    const t = useT(setupMessages);
    const [token, setToken] = useState('');
    const source = status.hfToken.source;

    async function save() {
        // 送ったらすぐ入力欄を空にする（画面にトークンを残さない）
        const value = token.trim();
        setToken('');
        await act(() => api.put<SetupStatus>('/api/setup/hf-token', { token: value }));
    }

    return (
        <Step title={t('tokenStep.title')} purpose={t('tokenStep.purpose')} ok={ok}>
            {source === 'env' && <Note>{t('tokenStep.fromEnv')}</Note>}
            {source === 'login' && <Note>{t('tokenStep.fromLogin')}</Note>}
            {source === 'file' ? (
                <div className='flex flex-wrap items-center gap-2'>
                    <Note>{t('tokenStep.saved')}</Note>
                    <Button
                        variant='outline'
                        size='sm'
                        disabled={locked}
                        onClick={() => void act(() => api.delete<SetupStatus>('/api/setup/hf-token'))}
                    >
                        {t('tokenStep.delete')}
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
                                {t('tokenStep.modelPage')}
                            </a>
                            {t('tokenStep.modelPageAfter')}
                        </li>
                        <li>
                            <a className='underline' href={HF_TOKENS_URL} target='_blank' rel='noreferrer noopener'>
                                {t('tokenStep.tokensPage')}
                            </a>
                            {t('tokenStep.tokensPageAfter')}
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
                            aria-label={t('tokenStep.title')}
                            placeholder='hf_…'
                            className='w-56'
                            value={token}
                            disabled={locked}
                            onChange={(e) => setToken(e.target.value)}
                        />
                        <Button type='submit' size='sm' disabled={locked || token.trim() === ''}>
                            {t('tokenStep.save')}
                        </Button>
                    </form>
                </>
            )}
        </Step>
    );
}
