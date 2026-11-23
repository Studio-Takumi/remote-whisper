import AuthenticationServices
import UIKit

/// システムのログイン画面（ASWebAuthenticationSession）を出し、カスタムスキームで戻ってきた URL を返す（#441）。
/// WKWebView の中では Google の OAuth が通らないので、ログインだけはここで開く。
/// ここの Cookie は WKWebView と共有されない（ログインのあとはトークンで使う。spec/mobile.md 11.10）
final class LoginSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    private let window: UIWindow?

    /// window はログイン画面を重ねる画面（アプリの画面の window）
    init(window: UIWindow?) {
        self.window = window
    }

    @MainActor
    func open(_ url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme) { [weak self] callback, error in
                self?.session = nil
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: AppAuthError.canceled)
                } else {
                    continuation.resume(throwing: AppAuthError.network)
                }
            }
            session.presentationContextProvider = self
            // Safari のログインの状態を使う（Google などに毎回ログインし直さなくてよいように）
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: AppAuthError.network)
            }
        }
    }

    func presentationAnchor(for _: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }
}
