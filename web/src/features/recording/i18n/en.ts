import type { ja } from '@/features/recording/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// 録音（features/recording/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    // 複数のファイルで使う文
    'common.chooseProject': 'Choose a project to record in from the menu',
    'common.continueRecording': 'Continue recording',
    'common.discard': 'Discard',
    'common.newSession': 'New session',

    // AudioUpload.tsx
    'audioUpload.cancel': 'Cancel',
    'audioUpload.create': 'Create',
    'audioUpload.dialogDescription': 'Choose how to create sessions',
    'audioUpload.dialogTitle': (p) => (Number(p.n) === 1 ? '1 audio file' : `${p.n} audio files`),
    'audioUpload.label': 'Create from audio file',
    'audioUpload.merge': 'Combine into one session',
    'audioUpload.mergeHint': 'Recordings of the same event from several microphones',
    'audioUpload.primarySource': 'Primary source',
    'audioUpload.separate': 'Separate sessions',
    'audioUpload.separateHint': 'Creates one session per file',
    'audioUpload.uploading': 'Uploading {name}… {percent}%',
    'audioUpload.way': 'How to create sessions',

    // closedRecordings.ts
    'closedRecordings.interrupted':
        'The session that was recording before the page was closed has been ended. The recording up to that point is kept',

    // continueWindow.ts
    'continueWindow.lessThanMinute': 'Less than 1 min left',
    'continueWindow.minutes': '{n} min left',

    // join.ts
    'join.browser': 'Browser',
    'join.disabled': 'Joining is turned off on this host',
    'join.full': 'The maximum number of audio sources has joined',
    'join.lost': 'You were disconnected. Join again',
    'join.unsupported': "This host doesn't support joining",

    // micAction.ts
    'micAction.backPaused': 'Paused in “{title}”. Click to go back',
    'micAction.backRecording': 'Recording in “{title}”. Click to go back',
    'micAction.chooseProjectHint': 'Choose a project',
    'micAction.continue': 'Click to continue recording (you can continue for {min} min after recording stops. {left})',
    'micAction.continueHint': 'Press to continue recording',
    'micAction.join': "{watched}. Click to join with this device's microphone",
    'micAction.joinHint': "Join with this device's microphone",
    'micAction.joined': 'Joined as audio source {source}',
    'micAction.joining': 'Joining…',
    'micAction.leave': '{joined}. Click to stop joining',
    'micAction.micDenied': 'The microphone is not allowed. Allow it in your browser settings',
    'micAction.micDeniedHint': 'The microphone is not allowed',
    'micAction.newSession': 'Click to create a new session in “{project}”',
    'micAction.newSessionHint': 'Press for a new session',
    'micAction.notice': 'Recording on another device. Use that device to control it',
    'micAction.pause': 'Click to pause',
    'micAction.reconnecting': 'Reconnecting to the host',
    'micAction.resume': 'Click to resume recording',
    'micAction.start': 'Click to start recording',
    'micAction.startHint': 'Press to start recording',
    'micAction.viewOnly': 'View only on this device',
    'micAction.watched': '{watched}. {reason}',

    // MicAlert.tsx
    'micAlert.reopen': 'Reopen microphone',

    // MicButton.tsx
    'micButton.joinedOther': 'Joined another session',
    'micButton.stop': 'Click to stop recording',
    'micButton.stopShort': 'Stop',

    // micMessages.ts
    'micMessages.ended': 'The microphone stopped. Nothing is being recorded. Press “Reopen microphone”',
    'micMessages.fallback': "The chosen microphone wasn't found, so the OS default microphone is used",
    'micMessages.fallbackWithLabel':
        "The chosen microphone ({label}) wasn't found, so the OS default microphone is used",
    'micMessages.muted':
        'No sound is coming from the microphone (another app or the OS has stopped it). Nothing is being recorded',
    'micMessages.stalled':
        'Sound is coming in, but no transcript appears (recording continues). Turning off “Browser echo cancellation” and “Browser noise suppression” in the settings may fix it',
    'micMessages.suspended':
        'Audio processing stopped (because of a call, a notification, or similar). Press “Reopen microphone”',
    'micMessages.withLabel': '{message} ({label})',

    // audio/microphone.ts
    'microphone.denied': 'Microphone use is not allowed',
    'microphone.insecure': "The microphone can't be used on this page (open it over HTTPS)",
    'microphone.missing': "The chosen microphone wasn't found",
    'microphone.openFailed': "Can't open the microphone: {message}",
    'microphone.processingFailed': "Can't start audio processing: {message}",

    // reconnect.ts
    'reconnect.interrupted':
        'The recording ended partway (the connection was down for a long time, the host restarted, or similar). The recording up to that point is kept',

    // recorder.ts
    'recorder.micDenied': "The microphone can't be used. Allow it in your browser settings",
    'recorder.recovered': 'Back to recording',
    'recorder.reopenFailed': "Can't reopen the microphone: {message}",
    'recorder.reopened': 'Microphone reopened. Recording continues',
    'recorder.switchFailed': "Can't switch the microphone: {message}",
    'recorder.switched': 'Microphone switched. Recording continues',
    'recorder.unsentOverflow':
        "A lot of audio hasn't reached the host, so audio from here on is lost if you reload the page. Keep the page open and wait for the connection",
    'recorder.waitingLeftover': 'Waiting to send the rest of the previous recording. Press again once connected',

    // recording.ts
    'recording.continueOther': "You can't continue another session's recording while recording",
    'recording.locked': "Can't be changed while recording",
    'recording.referenceMaterials': "You can't change reference materials while recording",
    'recording.regenerate': "Can't regenerate while recording",

    // RecordingLock.tsx
    'recordingLock.locked': "Settings can't be changed while recording",

    // UnsentAlert.tsx
    'unsentAlert.leadMinutes': "About {n} min of recording didn't reach the host the last time this page was open",
    'unsentAlert.leadSeconds': "{n} sec of recording didn't reach the host the last time this page was open",
    'unsentAlert.send': 'Send and continue',
    'unsentAlert.tail': '. You can send it and continue recording the same session',
    'unsentAlert.title': ' ({title})',

    // UnsentElsewhereAlert.tsx
    'unsentElsewhereAlert.offline': 'Offline',
    'unsentElsewhereAlert.offlineTitle': '{host} is offline',
    'unsentElsewhereAlert.removedHost': "Some recordings didn't reach a removed host",
    'unsentElsewhereAlert.switch': 'Switch',
    'unsentElsewhereAlert.unsentOnHost': "Some recordings didn't reach {host}",
    'unsentElsewhereAlert.unsentOnOtherHost': "Some recordings didn't reach another host",

    // unsentRecovery.ts
    'unsentRecovery.sendFailed': "Can't send the audio that didn't arrive: {message}",

    // upload.ts
    'upload.cutOff': 'The upload was interrupted',
    'upload.rejected': 'The host rejected it ({status})',

    // uploadActions.ts
    'uploadActions.busy': 'Another file is uploading. Choose again after it finishes',
    'uploadActions.created': 'Creating from {name}. The summary takes a little while',
    'uploadActions.demo': "Audio files can't be used in the demo",
    'uploadActions.failed': "Can't upload {name}: {message}",
    'uploadActions.failedItem': '{name} ({message})',
    'uploadActions.merged': (p) =>
        `Combining ${Number(p.total) === 1 ? '1 file' : `${p.total} files`} into one session. The summary takes a little while`,
    'uploadActions.oldHost': "This host doesn't support multiple audio sources, so the session uses only {name}",
    'uploadActions.partialFailed': (p) =>
        `Couldn't send ${p.failed}. In 30 min, the session will be created from the ${Number(p.n) === 1 ? '1 file' : `${p.n} files`} that arrived`,
    'uploadActions.progressName': '{name} ({i}/{total})',
    'uploadActions.separator': ', ',

    // watch.ts
    'watch.disconnected': 'Recording on another device (the connection to that device is lost)',
    'watch.paused': 'Paused on another device',
    'watch.recording': 'Recording on another device',
    'watch.stopped': 'Recording stopped on another device',

    // watcher.ts
    'watcher.disconnected': 'The connection to {source} was lost. Recording continues',
});
