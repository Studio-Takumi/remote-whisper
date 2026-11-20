#if DEBUG
import Foundation

/// 見た目を確かめるためのホーム画面のウィジェット（Debug のビルドだけ。#454）。
/// シミュレーターはマイクの入力がなく録音を始められないので、起動の引数で見本を置き場に書く（App Group を使っているときだけ）。
///   xcrun simctl launch booted <Bundle ID> -RWWidgetPreview recording   （paused・idle・clear も）
enum HomeWidgetPreview {
    static let argument = "-RWWidgetPreview"

    /// 見本を書いたら true
    static func writeIfRequested(_ writer: HomeWidgetWriter, arguments: [String] = ProcessInfo.processInfo.arguments) -> Bool {
        guard let index = arguments.firstIndex(of: argument), index + 1 < arguments.count else { return false }
        let now = Date()
        func sample(_ phase: RecordingPhase) -> RecordingActivityState {
            .make(
                phase: phase,
                elapsed: 12 * 60 + 34,
                title: "情報理論 第8回",
                lines: ["単位がビットになるのがわかりますね。", "ここ、期末に出しますからね"],
                now: now
            )
        }
        switch arguments[index + 1] {
        case "recording":
            writer.recording(sessionId: "preview", state: sample(.recording), now: now)
        case "paused":
            writer.recording(sessionId: "preview", state: sample(.paused), now: now)
        case "idle":
            // 前回の録音（1:28:40）を残して待機中にする
            let state = RecordingActivityState.make(
                phase: .recording, elapsed: 0, title: "11/19 3限", lines: [], now: now.addingTimeInterval(-5320)
            )
            writer.recording(sessionId: "preview", state: state, now: now.addingTimeInterval(-5320))
            writer.ended(now: now)
        case "clear":
            writer.ended(now: now)
        default:
            return false
        }
        return true
    }
}
#endif
