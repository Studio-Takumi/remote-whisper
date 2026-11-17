import { FolderIcon, PlusIcon, Trash2Icon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Row, Section } from '@/features/settings/SettingsParts';
import type { Settings } from '@/features/settings/settings';
import type { UpdateSection } from '@/features/settings/settingsDraft';

// 設定の「参考資料」ページ（読み込めるフォルダと拡張子）
export function MaterialsPage({ draft, update }: { draft: Settings; update: UpdateSection }) {
    return (
        <>
            <Section title='読み込めるフォルダ'>
                <div className='flex flex-col gap-2'>
                    {draft.materials.roots.map((root, i) => (
                        <div key={i} className='flex items-center gap-2'>
                            <FolderIcon className='size-4 shrink-0 text-muted-foreground' />
                            <Input
                                value={root}
                                placeholder='D:\work'
                                aria-label={`フォルダ ${i + 1}`}
                                onChange={(e) =>
                                    update('materials', {
                                        roots: draft.materials.roots.map((r, j) => (j === i ? e.target.value : r)),
                                    })
                                }
                            />
                            <Button
                                variant='ghost'
                                size='icon-sm'
                                aria-label='このフォルダを外す'
                                onClick={() =>
                                    update('materials', {
                                        roots: draft.materials.roots.filter((_, j) => j !== i),
                                    })
                                }
                            >
                                <Trash2Icon />
                            </Button>
                        </div>
                    ))}
                    <Button
                        variant='outline'
                        size='sm'
                        className='w-fit'
                        onClick={() => update('materials', { roots: [...draft.materials.roots, ''] })}
                    >
                        <PlusIcon />
                        フォルダを追加
                    </Button>
                </div>
            </Section>
            <Section title='読み込める拡張子'>
                <Row id='extensions' label='拡張子'>
                    <Input
                        id='extensions'
                        className='w-56'
                        value={draft.materials.extensions.join(', ')}
                        onChange={(e) => update('materials', { extensions: e.target.value.split(',') })}
                    />
                </Row>
            </Section>
            <Section title='図の読み取り'>
                <Row
                    id='read-figures'
                    label='PDF の図を読む'
                    description='図のあるページを画像にして読み、用語リストとコンテキストに使います。作るのに時間がかかります'
                >
                    <Switch
                        id='read-figures'
                        checked={draft.materials.readFigures ?? true}
                        onCheckedChange={(readFigures) => update('materials', { readFigures })}
                    />
                </Row>
            </Section>
        </>
    );
}
