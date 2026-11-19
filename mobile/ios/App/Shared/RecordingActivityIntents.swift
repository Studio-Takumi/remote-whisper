import AppIntents
import Foundation

// Live Activity のボタン（#453。iOS 17 から）。LiveActivityIntent はアプリのプロセスで動く。
// App と Widget Extension の両方に入れる（Extension はボタンに使い、実行はアプリ側）。
// ショートカットには出さない（ホーム画面のウィジェット・ショートカットからの操作は #454）

@available(iOS 17.0, *)
struct PauseRecordingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "録音を一時停止"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        await RecordingActivityAction.pause.post()
        return .result()
    }
}

@available(iOS 17.0, *)
struct ResumeRecordingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "録音を再開"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        await RecordingActivityAction.resume.post()
        return .result()
    }
}

@available(iOS 17.0, *)
struct StopRecordingIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "録音を終了"
    static let isDiscoverable = false

    func perform() async throws -> some IntentResult {
        await RecordingActivityAction.stop.post()
        return .result()
    }
}
