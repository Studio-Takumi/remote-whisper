// 上のバーの GPU の状態（GpuIndicator）に出す文と、ジョブのセッションの引き当て（spec/ui.md 8）
import type { GpuJobs, GpuStats } from '@/api/protocol';
import type { Project } from '@/api/types';
import type { JobSession } from '@/app/GpuJobRow';
import { routePath } from '@/app/router';

// 待っているジョブの数（まとめてあるものは count の分）
export function waitingCount(jobs: GpuJobs): number {
    return jobs.waiting.reduce((n, w) => n + w.count, 0);
}

// ボタンの読み上げと title。画面に出ない使用率とキュー数も分かるようにする
export function gpuTriggerLabel(gpu: GpuStats | null, waiting: number): string {
    const details = [gpu ? `使用率 ${gpu.util}%` : null, waiting > 0 ? `待ち ${waiting} 件` : null].filter(Boolean);
    return `GPU の状態とジョブの一覧${details.length > 0 ? `（${details.join('、')}）` : ''}`;
}

// ジョブのセッション（ID）から、タイトルと飛び先を引く。見つからなければ（消えた・まだ読み込んでいない）リンクにしない
export function findJobSession(projects: Project[], id: string | null): JobSession | null {
    if (!id) {
        return null;
    }
    for (const p of projects) {
        const session = p.sessions.find((x) => x.id === id);
        if (session) {
            return {
                title: session.title,
                href: routePath({ kind: 'session', key: session.uuid ?? session.id }),
                projectId: p.id,
                sessionId: session.id,
            };
        }
    }
    return { title: id, href: null };
}
