// 今回扱った資料の範囲（#182）を、画面に出す文にする
import type { MaterialRange } from '@/api/api';
import { materialsMessages } from '@/features/materials/i18n';

// 例: slides.pdf の 12〜30・40〜42 で作り直しました
export function describeMaterialRange(ranges: MaterialRange[]) {
    const byFile = new Map<string, string[]>();
    for (const r of ranges) {
        const span =
            r.from === r.to ? `${r.from}` : materialsMessages.t('materialRange.span', { from: r.from, to: r.to });
        byFile.set(r.file, [...(byFile.get(r.file) ?? []), span]);
    }
    const t = materialsMessages.t;
    const unit = (file: string) =>
        t(file.toLowerCase().endsWith('.pdf') ? 'materialRange.page' : 'materialRange.section');
    const parts = [...byFile].map(([file, spans]) =>
        t('materialRange.file', { file, spans: spans.join(t('materialRange.spanSeparator')), unit: unit(file) }),
    );
    return t('materialRange.redone', { parts: parts.join(t('materialRange.partSeparator')) });
}
