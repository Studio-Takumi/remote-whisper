import CryptoKit
import Foundation

/// クラウド版にログインするときの、一度きりの値（#441。spec/mobile.md 11.10・cloud.md 10.7）。
/// PKCE の verifier はアプリの中にだけ置き、中間サーバーには challenge（SHA-256）だけを送る。
/// state は、戻ってきた URL がこのログインのものかを確かめるのに使う
struct AppLoginRequest: Equatable {
    let verifier: String
    let challenge: String
    let state: String

    /// 戻り先のカスタムスキーム（#454 で Info.plist に登録済み）
    static let callbackScheme = "remotewhisper"

    init(verifier: String, state: String) {
        self.verifier = verifier
        self.challenge = Self.challenge(for: verifier)
        self.state = state
    }

    /// 新しい乱数で作る（verifier は 48 バイト＝ 64 文字、state は 16 バイト＝ 22 文字）
    static func make() -> AppLoginRequest {
        AppLoginRequest(verifier: randomToken(bytes: 48), state: randomToken(bytes: 16))
    }

    static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    /// システムのログイン画面で開く URL（<origin>/auth/app/login/<provider>?…）
    func loginURL(origin: RelayOrigin, provider: String) -> URL? {
        guard ["google", "discord", "github"].contains(provider) else { return nil }
        var components = URLComponents(url: origin.url, resolvingAgainstBaseURL: false)
        components?.path = "/auth/app/login/\(provider)"
        components?.queryItems = [
            URLQueryItem(name: "challenge", value: challenge),
            URLQueryItem(name: "challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
        ]
        return components?.url
    }

    /// 戻ってきた URL（remotewhisper://auth/callback?code=…&state=…）から、一度だけのコードを取り出す
    func code(from callback: URL) throws -> String {
        guard callback.scheme?.lowercased() == Self.callbackScheme, callback.host?.lowercased() == "auth",
              callback.path == "/callback",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems
        else {
            throw AppAuthError.badCallback
        }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        // ほかのログインの戻りなら使わない
        guard let state = value("state"), state == self.state else {
            throw AppAuthError.badCallback
        }
        if value("error") != nil {
            throw AppAuthError.canceled
        }
        guard let code = value("code"), !code.isEmpty else {
            throw AppAuthError.badCallback
        }
        return code
    }
}

enum AppAuthError: Error, Equatable {
    /// ログインをやめた（ログイン画面を閉じた・プロバイダの画面で断った）
    case canceled
    /// 戻ってきた URL の形が違う・ほかのログインのもの
    case badCallback
    /// 中間サーバーが断った（コードが違う・期限切れなど）
    case rejected(Int)
    /// つながらない
    case network
    /// 中間サーバーの URL が違う
    case badOrigin
}

func randomToken(bytes count: Int) -> String {
    var bytes = [UInt8](repeating: 0, count: count)
    let status = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    precondition(status == errSecSuccess, "SecRandomCopyBytes failed")
    return base64url(Data(bytes))
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

/// トークンを使う中間サーバー（クラウド版）のオリジン。https だけ（開発用に http://localhost も）。
/// トークンはオリジンごとに分けて持つ（staging と本番で混ぜない）。
/// JS が渡した origin をそのまま信じず、クラウド版のホスト（`cloudHosts`）だけにする（web の `VITE_CLOUD_HOSTS` の既定と同じ）。
/// Debug のビルドだけ、開発用の localhost・127.0.0.1（wrangler dev）も許す
struct RelayOrigin: Equatable, Hashable {
    let url: URL

    /// 本番と staging（spec/cloud.md 10.15）。クラウド版のドメインを変えたら、web の VITE_CLOUD_HOSTS と一緒に変える
    static let cloudHosts: Set<String> = ["rw.studio-takumi.dev", "rw-dev.studio-takumi.dev"]
    #if DEBUG
        static let allowsLocal = true
    #else
        static let allowsLocal = false
    #endif

    /// "https://rw.example" の形（パス・クエリ・ユーザー名のない URL）で、許したホストのものだけ
    init?(_ value: String, allowedHosts: Set<String> = RelayOrigin.cloudHosts, allowsLocal: Bool = RelayOrigin.allowsLocal) {
        guard let components = URLComponents(string: value), let scheme = components.scheme?.lowercased(),
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.path.isEmpty || components.path == "/"
        else {
            return nil
        }
        let local = host == "localhost" || host == "127.0.0.1"
        guard (scheme == "https" && allowedHosts.contains(host)) || (allowsLocal && local && (scheme == "http" || scheme == "https"))
        else { return nil }
        var normalized = URLComponents()
        normalized.scheme = scheme
        normalized.host = host
        normalized.port = components.port
        guard let url = normalized.url else { return nil }
        self.url = url
    }

    var key: String { url.absoluteString }

    func endpoint(_ path: String) -> URL {
        url.appendingPathComponent(String(path.drop { $0 == "/" }))
    }
}
