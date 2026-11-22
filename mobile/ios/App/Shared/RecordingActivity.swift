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
    /// 文字起こしの区切りを何個まで持つか
    static let maxLines = 12
    /// 区切り 1 つの長さの上限（文字）。長いときは後ろ（新しく話したところ）を残す
    static let maxLineLength = 120
    /// 区切りを新しいほうからためて、合わせてこの文字数に届いたら、それより前は持たない（ロック画面の 3 行は 60 文字ほど）
    static let maxTotalLength = 120

    var phase: RecordingPhase
    /// 経過時間が 0 だった時刻。録音中は、端末がここから数える（毎秒 update しない）
    var startedAt: Date
    /// 経過時間（秒。一時停止中に止めて出す長さ）
    var elapsed: TimeInterval
    var title: String
    /// 直近の文字起こしの区切り（古い順）。つなげて折り返すのは見る側（TranscriptText）。
    /// 区切りごとの色分け（新しい区切りだけ白）に区切りの境目が要るので、つなげずに持つ
    var lines: [String]

    /// 空の区切りを除き、新しいほうから合わせて 120 文字に届くまでだけ持つ（届いた区切りは全部入れる）。
    /// ActivityKit の中身は 4KB までなので、ここで抑える（最大でも 12 区切り・約 1.5KB）
    static func make(phase: RecordingPhase, elapsed: TimeInterval, title: String, lines: [String], now: Date = Date()) -> Self {
        let elapsed = max(0, elapsed)
        let cleaned = lines
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .map { $0.count > maxLineLength ? "…" + $0.suffix(maxLineLength - 1) : $0 }
        var kept: [String] = []
        var total = 0
        for line in cleaned.reversed() {
            if total >= maxTotalLength || kept.count >= maxLines { break }
            kept.append(line)
            total += line.count
        }
        return Self(
            phase: phase,
            startedAt: now.addingTimeInterval(-elapsed),
            elapsed: elapsed,
            title: title,
            lines: kept.reversed()
        )
    }

    /// 一時停止中は、止めたときの経過時間で止めて出す
    var pausedAt: Date? {
        phase == .paused ? startedAt.addingTimeInterval(elapsed) : nil
    }
}

/// 文字起こしの区切りのつなぎ方
enum TranscriptJoin {
    /// 区切りの間に入れるもの。前が英数字・記号（ASCII）で次が英数字で始まるときだけ空白（日本語は入れない）
    static func separator(between previous: String, and next: String) -> String {
        guard let a = previous.last, let b = next.first, a.isASCII, !a.isWhitespace, isWord(b) else { return "" }
        return " "
    }

    /// 区切りをつなげた 1 つの文章
    static func joined(_ lines: [String]) -> String {
        var text = ""
        for line in lines {
            text += separator(between: text, and: line) + line
        }
        return text
    }

    /// 区切りをつなげた文章の、あふれないぶんだけ（新しいほう）を返す。
    /// 区切りごとの色分けに境目が要るので、つなげずに区切りの配列で返す（先頭以外は、前との間の空白を頭に付ける）。
    /// あふれるときは、全体の頭に「…」を付ける。
    /// SwiftUI の `truncationMode(.head)` は複数行だと最後の行の頭だけを省略してしまう（途中から読めなくなる）ので、
    /// 見る側の幅から決めた幅の予算（全角 1 文字 = 1。半角は 0.55）で、こちらで切る
    static func fit(_ lines: [String], budget: Double) -> [String] {
        var taken: [String] = []
        var used = 0.0
        for index in stride(from: lines.count - 1, through: 0, by: -1) {
            let separator = index > 0 ? separator(between: lines[index - 1], and: lines[index]) : ""
            let piece = separator + lines[index]
            let cost = width(piece)
            if used + cost <= budget {
                taken.append(piece)
                used += cost
                continue
            }
            // 入りきらない区切りは、後ろから入るぶんだけ（「…」の 1 つぶんを残す）
            var tail = ""
            var tailWidth = 1.0
            for c in lines[index].reversed() {
                let w = width(c)
                if used + tailWidth + w > budget { break }
                tail.insert(c, at: tail.startIndex)
                tailWidth += w
            }
            if tail.isEmpty, let first = taken.popLast() {
                // 1 文字も入らないときは、前に入れた区切りの頭に付ける（その区切りの前の空白は要らない）
                taken.append("…" + first.drop(while: { $0 == " " }))
            } else if !tail.isEmpty {
                taken.append("…" + tail)
            }
            break
        }
        return Array(taken.reversed())
    }

    /// 幅の見積もり（全角 1・半角 0.55）
    static func width(_ text: String) -> Double {
        text.reduce(0) { $0 + width($1) }
    }

    private static func width(_ c: Character) -> Double {
        c.isASCII ? 0.55 : 1
    }

    private static func isWord(_ c: Character) -> Bool {
        c.isASCII && (c.isLetter || c.isNumber)
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
