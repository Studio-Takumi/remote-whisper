// 今回扱った資料の範囲（#182）を、画面に出す文にする
import type { MaterialRange } from '@/api';

// 例: slides.pdf の 12〜30・40〜42 で作り直しました
export function describeMaterialRange(ranges: MaterialRange[]) {
    const byFile = new Map<string, string[]>();
    for (const r of ranges) {
        const span = r.from === r.to ? `${r.from}` : `${r.from}〜${r.to}`;
        byFile.set(r.file, [...(byFile.get(r.file) ?? []), span]);
    }
    const unit = (file: string) => (file.toLowerCase().endsWith('.pdf') ? 'ページ' : '番目の区切り');
    const parts = [...byFile].map(([file, spans]) => `${file} の ${spans.join('・')} ${unit(file)}`);
    return `参考資料は、今回扱った範囲（${parts.join('、')}）で作り直しました`;
}
