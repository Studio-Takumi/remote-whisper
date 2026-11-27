// 上のバーの GPU の状態（GpuIndicator）に出す文と、ジョブのセッションの引き当て（spec/ui.md 8）
import type { GpuJobs, GpuStats } from '@/api/protocol';
import type { Project } from '@/api/types';
import { appMessages } from '@/app/i18n';
import { routePath } from '@/app/router';

// ジョブの行に出すセッション。href が null なら見つからない（リンクにしない）
export type JobSession = { title: string; href: string | null; projectId?: string; sessionId?: string };

// 待っているジョブの数（まとめてあるものは count の分）
export function waitingCount(jobs: GpuJobs): number {
    return jobs.waiting.reduce((n, w) => n + w.count, 0);
}

// ボタンの読み上げと title。画面に出ない使用率とキュー数も分かるようにする
export function gpuTriggerLabel(gpu: GpuStats | null, waiting: number): string {
    const t = appMessages.t;
    const details = [
        gpu ? t('gpuJobs.usage', { util: gpu.util }) : null,
        waiting > 0 ? t('gpuJobs.waiting', { count: waiting }) : null,
    ].filter(Boolean);
    return details.length > 0
        ? t('gpuJobs.triggerWithDetails', { details: details.join(t('gpuJobs.detailSeparator')) })
        : t('gpuJobs.trigger');
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
