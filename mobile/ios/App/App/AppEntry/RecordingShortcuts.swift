import AppIntents

/// ショートカット・Siri に「録音を始める」を出す（#454。iOS 16 から）
@available(iOS 16.0, *)
struct RecordingShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartRecordingIntent(),
            phrases: [
                "\(.applicationName)で録音を始める",
                "\(.applicationName)で録音",
            ],
            shortTitle: "録音を始める",
            systemImageName: "mic.fill"
        )
    }
}
