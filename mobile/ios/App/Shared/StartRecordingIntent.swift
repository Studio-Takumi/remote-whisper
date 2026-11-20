import AppIntents
import Foundation

/// 「録音を始める」（#454。spec/mobile.md 11.6）。ショートカット・Siri・コントロールセンター（iOS 18 から）から使う。
/// iOS はアプリが前面にないとマイクを開けないので、アプリを開いてから、いつもの Web の録音の開始を web/ に頼む。
/// App と Widget Extension の両方に入れる（Extension はコントロールのボタンに使い、実行はアプリ側）
@available(iOS 16.0, *)
struct StartRecordingIntent: AppIntent {
    static let title: LocalizedStringResource = "録音を始める"
    static let description = IntentDescription("Remote Whisper を開いて、最後に開いていたプロジェクトで録音を始めます")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        AppEntryInbox.shared.deliver(.record)
        return .result()
    }
}
