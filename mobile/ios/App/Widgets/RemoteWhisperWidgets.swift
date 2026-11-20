import SwiftUI
import WidgetKit

/// Widget Extension の入口。Live Activity（#453）と、ホーム画面・ロック画面のウィジェット・コントロール（#454）
@main
struct RemoteWhisperWidgets: WidgetBundle {
    var body: some Widget {
        RecordingLiveActivity()
        HomeWidget()
        LockScreenWidget()
        if #available(iOS 18.0, *) {
            StartRecordingControl()
        }
    }
}
