import type { ja } from '@/features/cloud/i18n/ja';
import { defineTranslation } from '@/i18n/messages';

// クラウド版（features/cloud/）の文（英語）。訳は docs/spec/i18n.md の用語集に合わせる
export const en = defineTranslation<typeof ja>()({
    'common.appNameCloudEdition': 'Remote Whisper (Cloud edition)',
    'common.cancel': 'Cancel',
    'common.checking': 'Checking…',
    'common.loading': 'Loading…',
    'common.loggedInAs': 'Logged in as {name}',
    'common.logout': 'Log out',
    'common.offline': 'Offline',
    'common.online': 'Online',
    'common.remove': 'Remove',
    'common.removeFailed': "Can't remove: {message}",
    'common.removed': 'Removed {name}',

    'accountDialog.addProvider': 'Add {provider}',
    'accountDialog.cannotAddInApp': 'You can add login methods when this is opened in a browser',
    'accountDialog.deleteAccount': 'Delete account',
    'accountDialog.deleteAccountConfirm': "This deletes your account and registered hosts. It can't be undone",
    'accountDialog.deleteAccountFailed': "Can't delete the account: {message}",
    'accountDialog.deleteAccountStart': 'Delete account…',
    'accountDialog.deleted': 'Account deleted',
    'accountDialog.lastProviderCannotRemove': "You can't remove your last login method",
    'accountDialog.logoutEverywhere': 'Log out of all devices',
    'accountDialog.logoutEverywhereConfirm': 'This logs you out on all devices, including this one',
    'accountDialog.logoutEverywhereDo': 'Log out',
    'accountDialog.logoutEverywhereFailed': "Can't log out: {message}",
    'accountDialog.providers': 'Login methods',
    'accountDialog.title': 'Account',

    'announcementBanner.close': 'Close',
    'announcementBanner.learnMore': 'Learn more',

    'cloudEntry.login': 'Log in',

    'cloudHostBadge.connected': 'Connected to {name}',
    'cloudHostBadge.fallbackName': 'Host',
    'cloudHostBadge.label': 'Connected to {name} (press to switch hosts)',

    'consentForm.agree': 'I agree to the terms of service and the privacy policy',
    'consentForm.agreeRequired': 'To continue, you need to agree to the terms of service and the privacy policy',
    'consentForm.consentFailed': "Couldn't send your consent: {message}",
    'consentForm.dataCollection':
        'The cloud edition collects data to improve quality (it does not collect the text of transcripts, summaries, and the like)',
    'consentForm.introAfter': '.',
    'consentForm.introAnd': ' and the ',
    'consentForm.introBefore': 'Before you start, read the ',
    'consentForm.privacy': 'privacy policy',
    'consentForm.refetchFailed':
        "Your consent was sent, but the status couldn't be reloaded. Press “Agree and continue” again",
    'consentForm.submit': 'Agree and continue',
    'consentForm.terms': 'terms of service',
    'consentForm.title': 'Agree to the terms of service',

    'devicesSection.lastUsed': 'Used {date}',
    'devicesSection.notice': "Removed devices can't be used until they log in again",
    'devicesSection.thisDevice': 'This device',
    'devicesSection.title': 'App devices',

    'hostPicker.allOffline': 'All PCs are offline. Check that Remote Whisper is running on the PC',
    'hostPicker.checkRegistered': "I've registered it, check again",
    'hostPicker.checking': 'Checking hosts…',
    'hostPicker.choose': 'Choose host',
    'hostPicker.loadFailed': "Couldn't load the host list: {error}",
    'hostPicker.noneApprove': 'On the page that opens, check that the same code as in the tray is shown, and approve',
    'hostPicker.noneDescription': 'No PC (host) for transcription is registered yet',
    'hostPicker.noneLogin': 'From the tray icon (the menu bar on Mac), choose “Log in to the cloud edition”',
    'hostPicker.noneStart': 'Start Remote Whisper on the PC',
    'hostPicker.noneTitle': 'Register a PC',
    'hostPicker.reload': 'Reload the list',
    'hostPicker.retry': 'Try again',
    'hostPicker.selectHost': 'Select host',

    'hostsSection.empty': "None yet. Register one from “Log in to the cloud edition” in the PC's tray",
    'hostsSection.hostName': 'Host name',
    'hostsSection.removeConfirm': "After removing, this host can't be reached from the cloud edition",
    'hostsSection.removeLabel': 'Remove {name}',
    'hostsSection.removeLockedRecording': "You can't remove the connected host while recording",
    'hostsSection.rename': 'Name',
    'hostsSection.renameFailed': "Can't rename: {message}",
    'hostsSection.renameLabel': 'Rename {name}',
    'hostsSection.save': 'Save',
    'hostsSection.title': 'Hosts (PCs that transcribe)',

    'loginButtons.logInWith': 'Log in with {provider}',
    'loginButtons.loginFailed': "Couldn't log in. Try again",

    'pairPage.approve': 'Approve',
    'pairPage.askAfterHost': 'is asking to be registered to the account {name}. Approve?',
    'pairPage.checkCode':
        "Check that the code matches the one in the PC's tray notification. If it doesn't, or you don't recognize it, reject",
    'pairPage.countryMismatch': 'The PC that sent the request and this device are connecting from different countries',
    'pairPage.doNotApproveCode': "Don't approve a code someone sent you",
    'pairPage.doneAlreadyRegistered': '{host} is already registered',
    'pairPage.doneRegistered': "Registered {host}. A notification also appears in the PC's tray",
    'pairPage.doneRejected': 'Registration rejected',
    'pairPage.doneRejectedOrCanceled': 'This registration was rejected or canceled',
    'pairPage.errorApprovedByOther':
        "{host} was approved by another account. If you don't recognize this, choose “Remove from the cloud edition” in the PC's tray",
    'pairPage.loginFirst': 'Log in, then check the PC to register',
    // 2 つの span（inline-block）を空白なしで並べるので、空白は折り返しで消えない NBSP にする
    'pairPage.noPcWarningFirst': "If this PC isn't with you,\u00a0",
    'pairPage.noPcWarningSecond': "don't approve",
    'pairPage.openApp': 'Open Remote Whisper',
    'pairPage.registerHost': 'Register host',
    'pairPage.reject': 'Reject',
});
