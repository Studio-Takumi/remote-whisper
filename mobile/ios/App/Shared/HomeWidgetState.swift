import Foundation

/// ホーム画面のウィジェットに出す、録音の状態（#454。spec/mobile.md 11.6）。
/// アプリが App Group の共有の置き場（HomeWidgetStore）に書き、ウィジェットが読む。App と Widget Extension の両方に入れる
struct HomeWidgetState: Codable, Equatable {
    /// 録音中のもの。録音していなければ nil
    var recording: Recording?
    /// 前回の録音。まだ録音していなければ nil
    var last: LastRecording?

    struct Recording: Codable, Equatable {
        var sessionId: String
        var phase: RecordingPhase
        /// 経過時間が 0 だった時刻。ウィジェットは端末がここから数える
        var startedAt: Date
        /// 経過時間（秒。一時停止中に止めて出す長さ）
        var elapsed: TimeInterval
        var title: String
        /// 直近の文字起こしの 1 行
        var line: String
        /// 最後に書いた時刻。アプリが落とされたときに、録音を終えた時刻と見なす
        var updatedAt: Date
        /// 録音を始めた・一時停止・再開した時刻（行・経過時間だけの変化では変わらない）。
        /// ここから 8 時間たったら、アプリが落とされたものと見なして待機中にする
        var changedAt: Date

        var pausedAt: Date? {
            phase == .paused ? startedAt.addingTimeInterval(elapsed) : nil
        }

        /// 録音を終えた（終えたと見なした）ときの、前回の録音
        func finished(at end: Date) -> LastRecording {
            let duration = phase == .recording ? end.timeIntervalSince(startedAt) : elapsed
            return LastRecording(title: title, duration: max(0, duration), endedAt: end)
        }
    }

    struct LastRecording: Codable, Equatable {
        var title: String
        var duration: TimeInterval
        var endedAt: Date
    }
}

/// ウィジェットに出すもの
enum HomeWidgetContent: Equatable {
    case idle(last: HomeWidgetState.LastRecording?)
    case recording(HomeWidgetState.Recording)
}

/// 置き場の中身から、ウィジェットのタイムラインを作る
enum HomeWidgetTimeline {
    /// 録音を始めた・一時停止・再開してからこれだけたった録音中のものは、アプリが落とされたものと見なして待機中にする
    /// （Live Activity が出続ける長さと同じ）。行が変わらない（無音が続く）だけでは切り替わらないよう、行の変化を起点にしない
    static let staleAfter: TimeInterval = 8 * 60 * 60

    static func staleAt(_ recording: HomeWidgetState.Recording) -> Date {
        recording.changedAt.addingTimeInterval(staleAfter)
    }

    /// いま出すもの
    static func content(of state: HomeWidgetState?, now: Date) -> HomeWidgetContent {
        guard let state else { return .idle(last: nil) }
        if let recording = state.recording {
            if now < staleAt(recording) {
                return .recording(recording)
            }
            return .idle(last: recording.finished(at: recording.updatedAt))
        }
        return .idle(last: state.last)
    }

    /// タイムライン（出すものと、その時刻）。アプリが知らせるまで作り直さない。
    /// 経過時間は端末が数えるので、録音中も 1 つで足りる。録音中は、古くなる時刻に待機中に切り替える
    static func entries(of state: HomeWidgetState?, now: Date) -> [(date: Date, content: HomeWidgetContent)] {
        let current = content(of: state, now: now)
        guard case let .recording(recording) = current else { return [(now, current)] }
        let stale = staleAt(recording)
        return [(now, current), (stale, content(of: state, now: stale))]
    }
}

/// ウィジェットに出す文言
enum HomeWidgetText {
    /// 「前回 11/19 3限 · 1:28:40」。セッション名がなければ録音を終えた日付
    static func last(_ last: HomeWidgetState.LastRecording, calendar: Calendar = .current) -> String {
        let parts = lastParts(last, calendar: calendar)
        return parts.name + parts.duration
    }

    /// 「前回 11/19 3限」と「 · 1:28:40」に分けたもの。セッション名が長いときに、名前だけを省略して長さは残す
    static func lastParts(_ last: HomeWidgetState.LastRecording, calendar: Calendar = .current) -> (name: String, duration: String) {
        let title = last.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let name: String
        if title.isEmpty {
            let day = calendar.dateComponents([.month, .day], from: last.endedAt)
            name = "\(day.month ?? 0)/\(day.day ?? 0)"
        } else {
            name = title
        }
        return ("前回 \(name)", " · \(duration(last.duration))")
    }

    /// 12:34 ・ 1:28:40（1 時間を超えたら時間も出す）
    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded(.down)))
        let h = total / 3600
        let m = total / 60 % 60
        let s = total % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%d:%02d", m, s)
    }

    /// 直近の文字起こしを「」で囲む。長いときは後ろ（新しく話したところ）を残す。空なら nil。
    /// 小のウィジェットの 2 行（1 行は全角 9 文字ほど）に、閉じかっこまで収まる長さにする
    static func quoted(_ line: String, maxLength: Int = 16) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let body = trimmed.count > maxLength ? "…" + trimmed.suffix(maxLength - 1) : trimmed
        return "「\(body)」"
    }
}

/// App Group の共有の置き場（UserDefaults）。App Group の ID を Local.xcconfig に書いたときだけ使える。
/// ID は Info.plist の RWAppGroup（ビルドの設定 RW_APP_GROUP）から読む
final class HomeWidgetStore {
    static let infoKey = "RWAppGroup"
    static let stateKey = "homeWidgetState"
    /// ウィジェットの kind（HomeWidget の StaticConfiguration）。reloadTimelines で使う
    static let widgetKind = "RecordingHomeWidget"

    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    /// App Group が使えなければ nil（ID を書いていない・エンタイトルメントがない）
    static func shared(bundle: Bundle = .main) -> HomeWidgetStore? {
        guard let group = bundle.object(forInfoDictionaryKey: infoKey) as? String,
              !group.trimmingCharacters(in: .whitespaces).isEmpty,
              FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group) != nil,
              let defaults = UserDefaults(suiteName: group)
        else { return nil }
        return HomeWidgetStore(defaults: defaults)
    }

    func read() -> HomeWidgetState? {
        guard let data = defaults.data(forKey: Self.stateKey) else { return nil }
        return try? JSONDecoder().decode(HomeWidgetState.self, from: data)
    }

    func write(_ state: HomeWidgetState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        defaults.set(data, forKey: Self.stateKey)
    }
}
