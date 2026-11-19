import SwiftUI
import WidgetKit

/// Widget Extension の入口（#453）。ホーム画面・ロック画面のウィジェット（#454）もここに足す
@main
struct RemoteWhisperWidgets: WidgetBundle {
    var body: some Widget {
        RecordingLiveActivity()
    }
}
