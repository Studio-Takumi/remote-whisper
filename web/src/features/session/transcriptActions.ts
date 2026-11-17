// 用語リスト（#103・#175）と文字起こしの置き換え（#176）。先に画面で変えて、保存できなければ戻す
import { toast } from 'sonner';

import { type CorrectionsJson, type TermsJson, api } from '@/api/api';
import { isDemo } from '@/api/data';
import type { ActionContext } from '@/app/actionContext';
import { runMutation } from '@/app/query';
import { type Correction, applyCorrectionLocally, revertCorrection } from '@/features/session/corrections';

export async function rejectTerm(ctx: ActionContext, sessionId: string, term: string) {
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return;
    }
    const drop = (terms?: string[]) => terms?.filter((t) => t !== term);
    await runMutation(
        {
            // 先に画面から消す（失敗したら戻す）
            onMutate: () => {
                const old = ctx.sessions.findSession(sessionId);
                ctx.sessions.patchSession(sessionId, (x) => ({
                    ...x,
                    pickedTerms: drop(x.pickedTerms),
                    manualTerms: drop(x.manualTerms),
                }));
                return { pickedTerms: old?.pickedTerms, manualTerms: old?.manualTerms };
            },
            // 語はクエリで渡す（パスに入れると「\」「..」「%」を含む語がクラウド版の中継で弾かれる。#219）
            mutationFn: async () =>
                isDemo
                    ? null
                    : api.delete<TermsJson>(
                          `/api/projects/${projectId}/sessions/${sessionId}/terms?${new URLSearchParams({ term }).toString()}`,
                      ),
            onSuccess: (res) => {
                if (res) {
                    ctx.sessions.patchSession(sessionId, (x) => ({
                        ...x,
                        pickedTerms: res.pickedTerms,
                        manualTerms: res.manualTerms ?? x.manualTerms,
                    }));
                }
            },
            onError: (e, _v, before) => {
                ctx.sessions.patchSession(sessionId, (x) => ({ ...x, ...before }));
                toast.error(`用語を消せません: ${e.message}`);
            },
        },
        undefined,
    ).catch(() => {});
}

export async function addTerm(ctx: ActionContext, sessionId: string, term: string) {
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return false;
    }
    // 足せるか（不正な語・上限）はサーバーが決めるので、先には足さない
    return runMutation(
        {
            mutationFn: async (): Promise<TermsJson> =>
                isDemo
                    ? {
                          manualTerms: [
                              ...new Set([...(ctx.sessions.findSession(sessionId)?.manualTerms ?? []), term]),
                          ],
                          pickedTerms: (ctx.sessions.findSession(sessionId)?.pickedTerms ?? []).filter(
                              (t) => t !== term,
                          ),
                          rejectedTerms: [],
                      }
                    : api.post<TermsJson>(`/api/projects/${projectId}/sessions/${sessionId}/terms`, { term }),
            onSuccess: (res) =>
                ctx.sessions.patchSession(sessionId, (x) => ({
                    ...x,
                    pickedTerms: res.pickedTerms,
                    manualTerms: res.manualTerms ?? x.manualTerms,
                })),
            onError: (e) => toast.error(`用語を足せません: ${e.message}`),
        },
        undefined,
    ).then(
        () => true,
        () => false,
    );
}

export async function addCorrection(ctx: ActionContext, sessionId: string, correction: Correction) {
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return false;
    }
    return runMutation(
        {
            // 先に画面で置き換えておく（失敗したら戻す）
            onMutate: () => {
                const before = ctx.sessions.findSession(sessionId);
                ctx.sessions.patchSession(sessionId, (x) => applyCorrectionLocally(x, correction));
                const applied = ctx.sessions.findSession(sessionId);
                return before && applied ? { before, applied } : undefined;
            },
            mutationFn: async () =>
                isDemo
                    ? null
                    : api.post<CorrectionsJson>(
                          `/api/projects/${projectId}/sessions/${sessionId}/corrections`,
                          correction,
                      ),
            onSuccess: async (res) => {
                if (res) {
                    ctx.sessions.receiveCorrections(sessionId, res);
                    await ctx.sessions.refreshTranscripts(sessionId);
                }
            },
            // 戻す。置き換えた行のうち、待っている間にほかで変わっていないものだけを戻す（届いた行・ほかで変わった行は残す）
            onError: (e, _v, change) => {
                toast.error(`置き換えられません: ${e.message}`);
                if (change) {
                    ctx.sessions.patchSession(sessionId, (x) => ({
                        ...revertCorrection(x, change.before, change.applied),
                        manualTerms: change.before.manualTerms,
                        corrections: change.before.corrections,
                    }));
                }
            },
        },
        undefined,
    ).then(
        () => true,
        () => false,
    );
}

export async function removeCorrection(ctx: ActionContext, sessionId: string, correction: Correction) {
    const projectId = ctx.sessions.projectIdOf(sessionId);
    if (!projectId) {
        return;
    }
    const same = (c: Correction) => c.from === correction.from && c.to === correction.to;
    await runMutation(
        {
            // 先に一覧から外しておく（失敗したら戻す）。文字起こしの中身は、外せたら取り直して戻す
            onMutate: () => {
                const before = ctx.sessions.findSession(sessionId)?.corrections;
                ctx.sessions.patchSession(sessionId, (x) => ({
                    ...x,
                    corrections: x.corrections?.filter((c) => !same(c)),
                }));
                return before;
            },
            mutationFn: async () =>
                isDemo
                    ? null
                    : api.delete<CorrectionsJson>(
                          `/api/projects/${projectId}/sessions/${sessionId}/corrections?${new URLSearchParams({ from: correction.from, to: correction.to })}`,
                      ),
            onSuccess: async (res) => {
                if (res) {
                    ctx.sessions.receiveCorrections(sessionId, res);
                    // 浄書済みの文字起こしは表示のときに当てているので、外したら取り直す
                    await ctx.sessions.refreshTranscripts(sessionId);
                }
            },
            onError: (e, _v, before) => {
                ctx.sessions.patchSession(sessionId, (x) => ({ ...x, corrections: before }));
                toast.error(`置き換えを外せません: ${e.message}`);
            },
        },
        undefined,
    ).catch(() => {});
}
