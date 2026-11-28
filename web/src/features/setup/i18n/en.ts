import type { ja } from '@/features/setup/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// セットアップ（features/setup/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // 複数のファイルで使う文
    'common.cancel': 'Cancel',
    'common.installed': 'Installed',
    'common.recheck': 'Check again',

    // GpuStep.tsx
    'gpuStep.getCudaBuild': 'Get the Windows (CUDA) build',
    'gpuStep.notFound':
        'No GPU was found, so transcription runs on the CPU. It is several times slower than a GPU, and text takes a while to appear. A smaller model such as small makes it faster',
    'gpuStep.purpose': 'Makes transcription faster',
    'gpuStep.wrongBuild':
        'An NVIDIA GPU was found, but this Remote Whisper is the Windows (OpenVINO) build, so it runs on the CPU without the GPU. Reinstall the Windows (CUDA) build to run fast on the GPU (recordings and transcripts are kept)',

    // LlmStep.tsx
    'llmStep.lmStudioStart': "Start the LM Studio server. Turn on the server in LM Studio's “Developer” tab, or run ",
    'llmStep.lmStudioStartAfter': '',
    'llmStep.notInstalled': "Not installed, so summaries and term lists won't be made",
    'llmStep.ollamaNotRunning': "Ollama isn't running. Start it, then check again",
    'llmStep.openDownloadPage': 'Open the download page',
    'llmStep.purpose': 'The app that makes summaries and term lists',
    'llmStep.running': 'Running',
    'llmStep.serverRunning': 'The server is running',
    'llmStep.unauthorized': "Can't connect because the LM Studio token is wrong. Check it in Settings under “Summary”",

    // ModelsStep.tsx
    'modelsStep.downloadCancelled': 'Download canceled',
    'modelsStep.downloadFailed': "Couldn't download",
    'modelsStep.downloading': 'Downloading {model}',
    'modelsStep.lmStudioNote':
        "{model} is used while recording. If it isn't installed, a larger model runs instead, so transcription gets slow on GPUs with about 6 GB of VRAM",
    'modelsStep.notInstalled': 'Not installed',
    'modelsStep.purpose': '{llm} models for summaries and more',
    'modelsStep.stopInLmStudio': 'To stop it, stop it from LM Studio',
    'modelsStep.title': 'Summary models',

    // pullModels.ts
    'pullModels.button': 'Download',
    'pullModels.buttonAtLeast': 'Download (about {gb} GB or more)',
    'pullModels.buttonWithSize': 'Download (about {gb} GB)',
    'pullModels.progress': 'Downloading {model}{where} ({index}/{total}){amount}',
    'pullModels.progressAmount': ' · {percent}% ({done} / {total})',
    'pullModels.progressWhere': ' with {llm}',
    'pullModels.waitForLlm': 'You can download once {llm} is running',
    'pullModels.waitForRecording': 'You can download after recording stops',

    // setup.ts
    'setup.elapsedMinutes': '{m} min {s} sec',
    'setup.elapsedSeconds': '{s} sec',
    'setup.phaseDownloading': 'Downloading',
    'setup.phaseInstalling': 'Installing',
    'setup.phasePreparing': 'Preparing',
    'setup.phaseRollingBack': 'Rolling back',

    // SetupDialog.tsx
    'setupDialog.close': 'Close',
    'setupDialog.description':
        'Installs what is used for summaries, polishing, and speaker labeling. You can open it anytime from “Setup” in Settings',
    'setupDialog.later': 'Later',
    'setupDialog.title': 'Getting started',

    // SetupGuide.tsx
    'setupGuide.cloudReadOnly':
        'View only from the cloud edition. Use the screen opened directly on the host to make changes',
    'setupGuide.failed': "Couldn't complete",
    'setupGuide.skippable':
        'You can skip any of these (transcription works as is). Each runs as soon as you press its button',

    // StepParts.tsx
    'stepParts.missing': 'Missing',
    'stepParts.ready': 'Ready',

    // TokenStep.tsx
    'tokenStep.delete': 'Delete',
    'tokenStep.fromEnv': 'Using the token from the HF_TOKEN environment variable',
    'tokenStep.fromLogin': 'Using the token saved with hf auth login',
    'tokenStep.modelPage': 'Speaker labeling model page',
    'tokenStep.modelPageAfter': ': log in and accept the terms of use',
    'tokenStep.purpose': 'Used to download the speaker labeling model',
    'tokenStep.save': 'Save',
    'tokenStep.saved': 'Saved',
    'tokenStep.title': 'HuggingFace token',
    'tokenStep.tokensPage': 'Access tokens page',
    'tokenStep.tokensPageAfter': ': create a Read token and paste it below',

    // useSetupStatus.ts
    'useSetupStatus.loadFailed': "Couldn't load the setup status",

    // WhisperXStep.tsx
    'whisperXStep.cancelled': 'Canceled and rolled back',
    'whisperXStep.cost': 'Downloads about {download} GB and uses about {disk} GB of disk. Takes {min} to {max} min',
    'whisperXStep.devCommand': 'In the development environment, run this command in the server folder',
    'whisperXStep.install': 'Install',
    'whisperXStep.notInstallable':
        "This version can't install it from the screen. Run the installer of a newer version",
    'whisperXStep.package': ': {name}',
    'whisperXStep.progress': '{phase}{package} ({elapsed} elapsed)',
    'whisperXStep.purpose': 'The library used for polishing and speaker labeling',
    'whisperXStep.rollbackFailed':
        "Couldn't install or roll back. Reinstall with the installer (the log is log/whisperx-install.log in the data folder)",
    'whisperXStep.rolledBack':
        "Couldn't install, so it was rolled back (the log is log/whisperx-install.log in the data folder)",
    'whisperXStep.waitForRecording': 'You can install after recording stops',
});
