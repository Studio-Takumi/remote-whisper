import { useState } from 'react';

import { api } from '@/api/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DIARIZATION_MODEL_URL, HF_TOKENS_URL, type SetupStatus } from '@/features/setup/setup';
import { Note, Step } from '@/features/setup/steps/StepParts';

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
