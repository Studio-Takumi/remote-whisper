import AppIntents
import SwiftUI
import WidgetKit

/// コントロールセンターの「録音を始める」（#454。iOS 18 から）。押すとアプリを開いて、いつもの Web の録音を始める
@available(iOS 18.0, *)
struct StartRecordingControl: ControlWidget {
    static let kind = "StartRecordingControl"

    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: Self.kind) {
            ControlWidgetButton(action: StartRecordingIntent()) {
                Label("録音する", systemImage: "mic.fill")
            }
        }
        .displayName("録音を始める")
        .description("Remote Whisper を開いて録音を始めます。")
    }
}
