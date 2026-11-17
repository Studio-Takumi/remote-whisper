// 資料の選択で、プロジェクトのディレクトリまでの道すじを開くための判定。パスは GET /api/fs が返す実際のパス

const windowsStyle = (p: string) => /^[A-Za-z]:/.test(p) || p.includes('\\');

function parts(p: string): string[] {
    const segments = p.split(/[\\/]+/).filter(Boolean);
    // Windows はドライブ文字も含めて、大文字・小文字を区別しない
    return windowsStyle(p) ? segments.map((s) => s.toLowerCase()) : segments;
}

// dir が target そのものか、target の親（祖先）のディレクトリか
export function isSameOrAncestor(dir: string, target: string): boolean {
    const d = parts(dir);
    const t = parts(target);
    return d.length <= t.length && d.every((s, i) => s === t[i]);
}
