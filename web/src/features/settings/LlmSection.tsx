import { isCloud } from '@/api/endpoint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Row, Section } from '@/features/settings/SettingsParts';
import { LLM_NAMES, type LlmBackend, type Settings, llmBackend } from '@/features/settings/settings';
import { type LmStudioSettings, defaultLmStudio } from '@/features/settings/settingsDraft';

// クラウド版（トンネル）からは変えられない項目（接続先・使う LLM・トークン。サーバーの TUNNEL_LOCKED）
const TUNNEL_LOCK = 'クラウド版からは変えられません';

// 「要約」ページの上の、要約に使うアプリ（LLM。#327）と、その接続先
export function LlmSection({
    draft,
    saved,
    onChangeBackend,
    onChangeOllamaHost,
    onChangeLmStudio,
}: {
    draft: Settings;
    // 保存済みの設定（トークンが設定済みか）
    saved: Settings;
    onChangeBackend: (backend: LlmBackend) => void;
    onChangeOllamaHost: (host: string) => void;
    onChangeLmStudio: (patch: Partial<LmStudioSettings>) => void;
}) {
    const backend = llmBackend(draft);
    const lmstudio = { ...defaultLmStudio, ...draft.lmstudio };
    const locked = isCloud ? TUNNEL_LOCK : undefined;
    const tokenSet = saved.lmstudio?.tokenSet ?? false;
    // 消すことにした（保存すると消える）
    const clearing = lmstudio.token === null;
    return (
        <Section>
            <Row
                id='llm-backend'
                label='要約に使うアプリ'
                locked={locked}
                description='要約・用語リスト・コンテキストを作るアプリです。録音中に変えたときは、録音が終わってから切り替わります'
            >
                <Select value={backend} onValueChange={(v) => onChangeBackend(v as LlmBackend)}>
                    <SelectTrigger id='llm-backend' className='w-44'>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectGroup>
                            <SelectItem value='ollama'>{LLM_NAMES.ollama}</SelectItem>
                            <SelectItem value='lmstudio'>{LLM_NAMES.lmstudio}</SelectItem>
                        </SelectGroup>
                    </SelectContent>
                </Select>
            </Row>
            {backend === 'lmstudio' ? (
                <>
                    <Row id='lmstudio-host' label='LM Studio の URL' locked={locked}>
                        <Input
                            id='lmstudio-host'
                            className='w-56'
                            value={lmstudio.host}
                            onChange={(e) => onChangeLmStudio({ host: e.target.value })}
                        />
                    </Row>
                    <Row
                        id='lmstudio-token'
                        label='LM Studio のトークン'
                        locked={locked}
                        description={
                            clearing
                                ? '保存すると消えます'
                                : tokenSet
                                  ? '設定済みです。変えるときだけ入れます'
                                  : 'LM Studio で認証を求める設定にしたときだけ入れます'
                        }
                    >
                        <div className='flex items-center gap-2'>
                            {/* 入れた値も保存済みの値も表示しない。空のまま保存すると、保存済みのものを残す */}
                            <Input
                                id='lmstudio-token'
                                type='password'
                                autoComplete='off'
                                className='w-40'
                                placeholder={tokenSet && !clearing ? '設定済み' : '未設定'}
                                value={typeof lmstudio.token === 'string' ? lmstudio.token : ''}
                                onChange={(e) => onChangeLmStudio({ token: e.target.value })}
                            />
                            {tokenSet && !clearing && (
                                <Button variant='outline' size='sm' onClick={() => onChangeLmStudio({ token: null })}>
                                    消す
                                </Button>
                            )}
                            {clearing && (
                                <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => onChangeLmStudio({ token: undefined })}
                                >
                                    やめる
                                </Button>
                            )}
                        </div>
                    </Row>
                </>
            ) : (
                <Row id='ollama-host' label='Ollama の URL' locked={locked}>
                    <Input
                        id='ollama-host'
                        className='w-56'
                        value={draft.ollama.host}
                        onChange={(e) => onChangeOllamaHost(e.target.value)}
                    />
                </Row>
            )}
        </Section>
    );
}
