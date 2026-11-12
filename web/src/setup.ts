// 初回のセットアップの案内（#291。docs/spec/flows.md 6.15・ui.md 8・api.md 7.1）
import type { LlmBackend } from '@/settings';

// 全体設定のうち、案内が見るもの（浄書と話者分けのオン・オフ）
export type WhisperFlags = { whisper: { finalTranscript?: boolean; diarize?: boolean } };

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export type PullJob = {
    state: JobState;
    // 取っている先（#327）
    backend: LlmBackend;
    models: string[];
    // 取っているモデル（models の index 番目）
    model: string;
    index: number;
    // 取っているモデルの、取った量と全体（バイト）
    completed: number;
    total: number;
    error: string | null;
};

export type InstallJob = {
    state: JobState;
    phase: 'preparing' | 'downloading' | 'installing' | 'rollingBack';
    package: string | null;
    collected: number;
    rolledBack: boolean;
    rollbackFailed: boolean;
    elapsedSec: number;
};

export type SetupStatus = {
    runtime: 'windows-bundle' | 'mac-bundle' | 'dev';
    // トンネル（クラウド版）から見ている。ボタンは押せない
    remote: boolean;
    recording: boolean;
    gpu: 'nvidia' | 'mac' | 'none';
    // 使っている LLM（Ollama か LM Studio。#327）
    llm: {
        backend: LlmBackend;
        running: boolean;
        // 入っていそうか（動いていないときに「起動して」と「入れて」を出し分ける）
        found: boolean;
        // 動いているが、トークンが違う・ない（LM Studio で認証を求める設定のとき）
        unauthorized: boolean;
        downloadUrl: string;
        models: { name: string; sizeGb: number | null; installed: boolean }[];
        pull: PullJob | null;
        // 取得をやめると、取っている先も止まるか（LM Studio は止める API がないので止まらない）
        pullCancellable: boolean;
    };
    whisperx: {
        installed: boolean;
        installable: boolean;
        downloadGb: number;
        diskGb: number;
        minutes: [number, number];
        command: string | null;
        install: InstallJob | null;
    };
    // トークンそのものは返ってこない。出どころだけ
    hfToken: { source: 'env' | 'file' | 'login' | null };
};

// 話者分けのモデルのページ（利用条件に同意する）と、トークンを作るページ
export const DIARIZATION_MODEL_URL = 'https://huggingface.co/pyannote/speaker-diarization-community-1';
export const HF_TOKENS_URL = 'https://huggingface.co/settings/tokens';

// 古いホスト（#327 より前）は llm がなく、同じ中身を ollama で返す（クラウド版では web のほうが新しいことがある）。
// llm に読み替え、足りない項目は Ollama のときの値で埋める
export function normalizeSetup(raw: SetupStatus): SetupStatus {
    const old = (raw as { ollama?: Omit<SetupStatus['llm'], 'backend' | 'unauthorized' | 'pullCancellable'> }).ollama;
    if (raw.llm || !old) {
        return raw;
    }
    return {
        ...raw,
        llm: {
            backend: 'ollama',
            unauthorized: false,
            pullCancellable: true,
            ...old,
            pull: old.pull ? { ...old.pull, backend: old.pull.backend ?? 'ollama' } : null,
        },
    };
}

export function missingModels(status: SetupStatus) {
    return status.llm.models.filter((m) => !m.installed);
}

// 取っていないモデルの合計（GB。大きさが分からないものは数えない）
export function missingSizeGb(status: SetupStatus): number {
    const sum = missingModels(status).reduce((acc, m) => acc + (m.sizeGb ?? 0), 0);
    return Math.round(sum * 10) / 10;
}

// トークンが要るか（WhisperX で浄書して、話者分けをする設定のとき）
export function needsToken(settings: WhisperFlags): boolean {
    return (settings.whisper.finalTranscript ?? true) && (settings.whisper.diarize ?? true);
}

// 足りないものの一覧（案内の見出しの印と、初回に自動で出すかの判定に使う）
export function missingSteps(status: SetupStatus, settings: WhisperFlags) {
    const finalOn = settings.whisper.finalTranscript ?? true;
    return {
        llm: !status.llm.running,
        models: !status.llm.running || missingModels(status).length > 0,
        whisperx: finalOn && !status.whisperx.installed,
        token: status.whisperx.installed && needsToken(settings) && status.hfToken.source === null,
    };
}

export function hasMissing(status: SetupStatus, settings: WhisperFlags): boolean {
    return Object.values(missingSteps(status, settings)).some(Boolean);
}

// 取っている・入れている途中か（その間は状態を取り直し続ける）
export function isBusy(status: SetupStatus): boolean {
    return status.llm.pull?.state === 'running' || status.whisperx.install?.state === 'running';
}

// 初回に「はじめに」を自動で出すか。セルフホスト版で、足りないものがあり、この端末でまだ閉じていないとき
export function shouldAutoOpen(
    status: SetupStatus,
    settings: WhisperFlags,
    opts: { cloud: boolean; dismissed: boolean },
): boolean {
    return !opts.cloud && !status.remote && !opts.dismissed && hasMissing(status, settings);
}

// 閉じたことは端末ごとに覚える（ブラウザの localStorage。使えなければ覚えない）
const DISMISSED_KEY = 'rw.setupGuideDismissed';

function storage(): Storage | null {
    try {
        return localStorage;
    } catch {
        return null;
    }
}

export function guideDismissed(): boolean {
    try {
        return storage()?.getItem(DISMISSED_KEY) === '1';
    } catch {
        return false;
    }
}

export function dismissGuide(): void {
    try {
        storage()?.setItem(DISMISSED_KEY, '1');
    } catch {
        // 覚えられなくても閉じる
    }
}

export function formatGb(bytes: number): string {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

export function pullPercent(job: PullJob): number {
    return job.total > 0 ? Math.min(100, Math.floor((job.completed / job.total) * 100)) : 0;
}

export const PHASE_LABELS: Record<InstallJob['phase'], string> = {
    preparing: '準備中',
    downloading: 'ダウンロード中',
    installing: 'インストール中',
    rollingBack: '元に戻しています',
};

export function formatElapsed(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
