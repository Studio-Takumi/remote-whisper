#if DEBUG
import Foundation

/// 見た目を確かめるための Live Activity（Debug のビルドだけ。#453）。
/// シミュレーターはマイクの入力がなく録音を始められないので、起動の引数で見本を出す。
///   xcrun simctl launch booted <Bundle ID> -RWLiveActivityPreview recording   （または paused）
@available(iOS 16.1, *)
enum LiveActivityPreview {
    static let argument = "-RWLiveActivityPreview"

    static func startIfRequested(_ controller: LiveActivityController, arguments: [String] = ProcessInfo.processInfo.arguments) {
        guard let index = arguments.firstIndex(of: argument), index + 1 < arguments.count,
              let phase = RecordingPhase(rawValue: arguments[index + 1])
        else { return }
        let state = RecordingActivityState.make(
            phase: phase,
            elapsed: 12 * 60 + 34,
            title: "情報理論 第8回",
            lines: [
                "じゃあスライドの 12 枚目に戻って、",
                "この式で対数の底を 2 にすると、",
                "単位がビットになるのがわかりますね。",
            ]
        )
        _ = try? controller.start(sessionId: "preview", state: state)
    }
}
#endif
