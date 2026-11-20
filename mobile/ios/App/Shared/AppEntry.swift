import Foundation

/// ウィジェット・App Intents からアプリを開いたときに、web/ にしてほしいこと（#454。spec/mobile.md 11.6）。
/// App と Widget Extension の両方に入れる（Extension はウィジェットのリンクを作るのに使う）
enum AppEntryRequest: Equatable {
    /// 録音を始める（ホーム画面のウィジェットの待機中・App Intents）
    case record
    /// そのセッションを開く（ホーム画面のウィジェットの録音中）
    case session(String)
    /// アプリを開くだけ（ロック画面の円）
    case open

    static let scheme = "remotewhisper"

    /// remotewhisper://record ・ remotewhisper://session/<ID> ・ remotewhisper://open
    init?(url: URL) {
        guard url.scheme?.lowercased() == Self.scheme else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" }
        switch url.host?.lowercased() {
        case "record" where parts.isEmpty:
            self = .record
        case "open" where parts.isEmpty:
            self = .open
        case "session":
            guard parts.count == 1, let id = parts.first, !id.isEmpty else { return nil }
            self = .session(id)
        default:
            return nil
        }
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .record:
            components.host = "record"
        case .open:
            components.host = "open"
        case let .session(id):
            components.host = "session"
            components.path = "/" + id
        }
        return components.url!
    }

    /// web/ に送る中身。アプリを開くだけのときは送らない
    var event: [String: String]? {
        switch self {
        case .record:
            ["kind": "record"]
        case let .session(id):
            ["kind": "session", "sessionId": id]
        case .open:
            nil
        }
    }
}

/// 届いた AppEntryRequest を、受け取る側（AppEntryPlugin）に渡す。
/// アプリを開いた直後は受け取る側がまだいない（画面とプラグインを読み込む前）ので、最後の 1 つを取っておく
@MainActor
final class AppEntryInbox {
    static let shared = AppEntryInbox()

    private var pending: AppEntryRequest?
    private var handler: ((AppEntryRequest) -> Void)?

    func deliver(_ request: AppEntryRequest) {
        if let handler {
            handler(request)
        } else {
            pending = request
        }
    }

    /// 開いた URL のうち、このアプリのものだけを渡す
    func deliver(urls: [URL]) {
        for url in urls {
            if let request = AppEntryRequest(url: url) {
                deliver(request)
            }
        }
    }

    /// 受け取る側を決める。取っておいたものがあれば、すぐ渡す
    func receive(_ handler: @escaping (AppEntryRequest) -> Void) {
        self.handler = handler
        if let pending {
            self.pending = nil
            handler(pending)
        }
    }
}
