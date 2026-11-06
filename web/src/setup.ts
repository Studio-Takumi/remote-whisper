// 初回のセットアップの案内（#291。docs/spec/flows.md 6.15・ui.md 8・api.md 7.1）

// 全体設定のうち、案内が見るもの（浄書と話者分けのオン・オフ）
export type WhisperFlags = { whisper: { finalTranscript?: boolean; diarize?: boolean } };

export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export type PullJob = {
    state: JobState;
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
    ollama: {
        running: boolean;
        found: boolean;
        downloadUrl: string;
        models: { name: string; sizeGb: number | null; installed: boolean }[];
        pull: PullJob | null;
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

export function missingModels(status: SetupStatus) {
    return status.ollama.models.filter((m) => !m.installed);
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
        ollama: !status.ollama.running,
        models: !status.ollama.running || missingModels(status).length > 0,
        whisperx: finalOn && !status.whisperx.installed,
        token: status.whisperx.installed && needsToken(settings) && status.hfToken.source === null,
    };
}

export function hasMissing(status: SetupStatus, settings: WhisperFlags): boolean {
    return Object.values(missingSteps(status, settings)).some(Boolean);
}

// 取っている・入れている途中か（その間は状態を取り直し続ける）
export function isBusy(status: SetupStatus): boolean {
    return status.ollama.pull?.state === 'running' || status.whisperx.install?.state === 'running';
}

// 初回に「はじめに」を自動で出すか。ダイレクト版で、足りないものがあり、この端末でまだ閉じていないとき
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
