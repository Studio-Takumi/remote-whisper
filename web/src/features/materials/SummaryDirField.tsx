import { useState } from 'react';

import { toast } from 'sonner';

import type { Project } from '@/api/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { materialsMessages } from '@/features/materials/i18n';
import { saveSummaryDir } from '@/features/materials/summaryDir';
import { useT } from '@/i18n/messages';

// 最終要約のコピーの置き場所（project.json の summaryDir。spec/files.md 5.4 節、#341）。
// 選んだディレクトリからの相対パス。検証はサーバーがする（不正なら 422 の理由を出す）
export function SummaryDirField({ project }: { project: Project }) {
    const t = useT(materialsMessages);
    const saved = project.summaryDir ?? '';
    // プロジェクトを切り替えたら、書きかけの値は捨てる
    const [draft, setDraft] = useState({ pid: project.id, value: saved });
    const value = draft.pid === project.id ? draft.value : saved;
    const [saving, setSaving] = useState(false);

    const save = async () => {
        if (value === saved || saving) {
            return;
        }
        setSaving(true);
        try {
            // サーバーがそろえた値（./summary/ → summary）を出す
            const summaryDir = await saveSummaryDir(project.id, value);
            setDraft({ pid: project.id, value: summaryDir });
            toast.success(t('summaryDirField.saved'));
        } catch (e) {
            // 欄は書いたまま残す
            toast.error(t('summaryDirField.saveFailed', { error: (e as Error).message }));
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className='flex flex-col gap-1.5'>
            <label htmlFor='summary-dir' className='text-sm'>
                {t('summaryDirField.label')}
                <span className='block text-xs text-muted-foreground'>{t('summaryDirField.hint')}</span>
            </label>
            <div className='flex gap-2'>
                <Input
                    id='summary-dir'
                    value={value}
                    placeholder={t('summaryDirField.placeholder')}
                    onChange={(e) => setDraft({ pid: project.id, value: e.target.value })}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                            void save();
                        }
                    }}
                />
                <Button variant='outline' disabled={value === saved || saving} onClick={() => void save()}>
                    {t('summaryDirField.save')}
                </Button>
            </div>
        </div>
    );
}
