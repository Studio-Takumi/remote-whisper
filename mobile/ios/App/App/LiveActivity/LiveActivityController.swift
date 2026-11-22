import Foundation

/// ActivityKit を呼ぶところ。テストでは偽物に差し替える
protocol LiveActivityClient: AnyObject {
    /// 設定で Live Activity が許可されているか
    var enabled: Bool { get }
    /// 新しく出して、その ID を返す
    func request(sessionId: String, state: RecordingActivityState) throws -> String
    func update(id: String, state: RecordingActivityState)
    func end(id: String)
    /// このアプリの Live Activity を全部終える（前に落とされたときの残りも）
    func endAll()
}

/// web/ から呼ばれる start・update・end を、出している 1 つの Live Activity に当てる（#453。spec/mobile.md 11.5）
final class LiveActivityController {
    enum Outcome: Equatable {
        case started
        case updated
        case ended
        /// 出していないので何もしなかった
        case ignored
        /// 設定で許可されていない
        case disabled
    }

    private let client: LiveActivityClient
    private(set) var current: (id: String, sessionId: String)?

    init(client: LiveActivityClient) {
        self.client = client
    }

    /// 同じセッションのものを出していれば中身を変えるだけ。別のセッションのものは終えてから出す
    func start(sessionId: String, state: RecordingActivityState) throws -> Outcome {
        if let current, current.sessionId == sessionId {
            client.update(id: current.id, state: state)
            return .updated
        }
        guard client.enabled else { return .disabled }
        if let current {
            client.end(id: current.id)
            self.current = nil
        }
        current = (try client.request(sessionId: sessionId, state: state), sessionId)
        return .started
    }

    func update(state: RecordingActivityState) -> Outcome {
        guard let current else { return .ignored }
        client.update(id: current.id, state: state)
        return .updated
    }

    /// 出しているものを終える。覚えていないもの（web/ を読み込み直す前に出したものなど）も残さない
    func end() -> Outcome {
        client.endAll()
        guard current != nil else { return .ignored }
        current = nil
        return .ended
    }
}

/// start の返事（`{ shown, reason?, message? }`。#462）。出せなかったときは理由を付け、web/ が `[LiveActivity]` でコンソールに出す
struct LiveActivityReply: Equatable {
    enum Reason: String {
        /// 設定で Live Activity が許可されていない
        case notAllowed = "not-allowed"
        /// iOS 16.1 より前
        case iosTooOld = "ios-too-old"
        /// ActivityKit が断った（`message` に詳細）
        case requestFailed = "request-failed"
    }

    var shown: Bool
    var reason: Reason?
    var message: String?

    static let iosTooOld = Self(shown: false, reason: .iosTooOld, message: nil)

    init(shown: Bool, reason: Reason? = nil, message: String? = nil) {
        self.shown = shown
        self.reason = reason
        self.message = message
    }

    init(outcome: LiveActivityController.Outcome) {
        switch outcome {
        case .started, .updated:
            self.init(shown: true)
        case .disabled:
            self.init(shown: false, reason: .notAllowed)
        case .ended, .ignored:
            self.init(shown: false)
        }
    }

    init(failure error: Error) {
        self.init(shown: false, reason: .requestFailed, message: error.localizedDescription)
    }

    /// プラグインの返事にする辞書
    var payload: [String: Any] {
        var result: [String: Any] = ["shown": shown]
        if let reason { result["reason"] = reason.rawValue }
        if let message { result["message"] = message }
        return result
    }
}

/// web/ から届く start・update の引数（spec/mobile.md 11.5）
struct LiveActivityRequest: Equatable {
    var sessionId: String?
    var state: RecordingActivityState

    enum ParseError: Error, Equatable {
        case missing(String)
        case invalidState(String)
    }

    static func parse(_ data: [String: Any], requireSession: Bool, now: Date = Date()) throws -> Self {
        let sessionId = data["sessionId"] as? String
        if requireSession, sessionId?.isEmpty ?? true {
            throw ParseError.missing("sessionId")
        }
        guard let raw = data["state"] as? String else { throw ParseError.missing("state") }
        guard let phase = RecordingPhase(rawValue: raw) else { throw ParseError.invalidState(raw) }
        let elapsed = (data["elapsed"] as? NSNumber)?.doubleValue ?? 0
        let title = data["title"] as? String ?? ""
        let lines = (data["lines"] as? [Any])?.compactMap { $0 as? String } ?? []
        return Self(
            sessionId: sessionId,
            state: .make(phase: phase, elapsed: elapsed, title: title, lines: lines, now: now)
        )
    }
}
