import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif

/// Live Activity に出す録音の状態（#453。spec/mobile.md 11.5）。App と Widget Extension の両方に入れる
enum RecordingPhase: String, Codable, Hashable {
    case recording
    case paused
}

/// Live Activity の中身（ActivityKit の ContentState）。web/ の録音の状態から作る。
/// セッション名は録音中に仮のタイトルに変わるので、変わらないもの（Attributes）ではなくこちらに持つ
struct RecordingActivityState: Codable, Hashable {
    static let maxLines = 3
    static let maxLineLength = 120

    var phase: RecordingPhase
    /// 経過時間が 0 だった時刻。録音中は、端末がここから数える（毎秒 update しない）
    var startedAt: Date
    /// 経過時間（秒。一時停止中に止めて出す長さ）
    var elapsed: TimeInterval
    var title: String
    /// 直近の文字起こし（古い順。最大 3 行）
    var lines: [String]

    /// 空の行を除き、最後の 3 行だけにする。長い行は後ろ（新しく話したところ）を残す。
    /// ActivityKit の中身は 4KB までなので、ここで抑える
    static func make(phase: RecordingPhase, elapsed: TimeInterval, title: String, lines: [String], now: Date = Date()) -> Self {
        let elapsed = max(0, elapsed)
        let kept = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .suffix(maxLines)
            .map { $0.count > maxLineLength ? "…" + $0.suffix(maxLineLength - 1) : $0 }
        return Self(
            phase: phase,
            startedAt: now.addingTimeInterval(-elapsed),
            elapsed: elapsed,
            title: title,
            lines: Array(kept)
        )
    }

    /// 一時停止中は、止めたときの経過時間で止めて出す
    var pausedAt: Date? {
        phase == .paused ? startedAt.addingTimeInterval(elapsed) : nil
    }

    /// 一時停止中は最後の 1 行だけ出す
    var visibleLines: [String] {
        phase == .paused ? Array(lines.suffix(1)) : lines
    }
}

#if canImport(ActivityKit)
/// 録音の Live Activity。変わらないものはセッションの ID だけ
@available(iOS 16.1, *)
struct RecordingActivityAttributes: ActivityAttributes {
    typealias ContentState = RecordingActivityState

    var sessionId: String
}
#endif

/// Live Activity のボタンの操作。ボタン（LiveActivityIntent）はアプリのプロセスで動くので、
/// 通知で LiveActivityPlugin に渡し、プラグインが web/ に伝える（録音の処理は web/ のまま）
enum RecordingActivityAction: String, CaseIterable {
    case pause
    case resume
    case stop

    static let notification = Notification.Name("RecordingActivityAction")
    static let userInfoKey = "action"

    @MainActor
    func post() {
        NotificationCenter.default.post(name: Self.notification, object: nil, userInfo: [Self.userInfoKey: rawValue])
    }
}
