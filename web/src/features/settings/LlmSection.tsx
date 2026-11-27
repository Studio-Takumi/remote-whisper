import { isCloud } from '@/api/endpoint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Row, Section } from '@/features/settings/SettingsParts';
import { settingsMessages } from '@/features/settings/i18n';
import { LLM_NAMES, type LlmBackend, type Settings, llmBackend } from '@/features/settings/settings';
import { type LmStudioSettings, defaultLmStudio } from '@/features/settings/settingsDraft';
import { useT } from '@/i18n/messages';

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
    const t = useT(settingsMessages);
    const backend = llmBackend(draft);
    const lmstudio = { ...defaultLmStudio, ...draft.lmstudio };
    // クラウド版（トンネル）からは変えられない項目（接続先・使う LLM・トークン。サーバーの TUNNEL_LOCKED）
    const locked = isCloud ? t('llmSection.tunnelLock') : undefined;
    const tokenSet = saved.lmstudio?.tokenSet ?? false;
    // 消すことにした（保存すると消える）
    const clearing = lmstudio.token === null;
    return (
        <Section>
            <Row
                id='llm-backend'
                label={t('llmSection.backend')}
                locked={locked}
                description={t('llmSection.backendDescription')}
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
                    <Row id='lmstudio-host' label={t('llmSection.url', { llm: LLM_NAMES.lmstudio })} locked={locked}>
                        <Input
                            id='lmstudio-host'
                            className='w-56'
                            value={lmstudio.host}
                            onChange={(e) => onChangeLmStudio({ host: e.target.value })}
                        />
                    </Row>
                    <Row
                        id='lmstudio-token'
                        label={t('llmSection.token', { llm: LLM_NAMES.lmstudio })}
                        locked={locked}
                        description={
                            clearing
                                ? t('llmSection.tokenClearing')
                                : tokenSet
                                  ? t('llmSection.tokenSet')
                                  : t('llmSection.tokenUnset', { llm: LLM_NAMES.lmstudio })
                        }
                    >
                        <div className='flex items-center gap-2'>
                            {/* 入れた値も保存済みの値も表示しない。空のまま保存すると、保存済みのものを残す */}
                            <Input
                                id='lmstudio-token'
                                type='password'
                                autoComplete='off'
                                className='w-40'
                                placeholder={
                                    tokenSet && !clearing
                                        ? t('llmSection.tokenSetShort')
                                        : t('llmSection.tokenUnsetShort')
                                }
                                value={typeof lmstudio.token === 'string' ? lmstudio.token : ''}
                                onChange={(e) => onChangeLmStudio({ token: e.target.value })}
                            />
                            {tokenSet && !clearing && (
                                <Button variant='outline' size='sm' onClick={() => onChangeLmStudio({ token: null })}>
                                    {t('llmSection.clear')}
                                </Button>
                            )}
                            {clearing && (
                                <Button
                                    variant='outline'
                                    size='sm'
                                    onClick={() => onChangeLmStudio({ token: undefined })}
                                >
                                    {t('llmSection.cancelClear')}
                                </Button>
                            )}
                        </div>
                    </Row>
                </>
            ) : (
                <Row id='ollama-host' label={t('llmSection.url', { llm: LLM_NAMES.ollama })} locked={locked}>
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
