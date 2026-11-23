import Capacitor
import UIKit

/// JS から呼ぶ、クラウド版のログインのプラグイン（`Capacitor.Plugins.AppAuth`。#441。API は spec/mobile.md 11.10）。
/// JS との受け渡しだけ。ログイン画面は `LoginSheet`、トークンは `AppAuthSession`（Keychain）が持つ。
/// web/ に渡すのは短い期限のアクセストークンだけで、更新トークンは渡さない
@objc(AppAuthPlugin)
public class AppAuthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppAuthPlugin"
    public let jsName = "AppAuth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "login", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "accessToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "logout", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "forget", returnType: CAPPluginReturnPromise),
    ]

    private let session = AppAuthSession(
        store: KeychainTokenStore(),
        client: AppAuthClient(transport: URLSessionTransport())
    )
    private var sheet: LoginSheet?

    private func origin(_ call: CAPPluginCall) -> RelayOrigin? {
        guard let origin = RelayOrigin(call.getString("origin") ?? "") else {
            call.reject("bad origin", "bad-origin")
            return nil
        }
        return origin
    }

    /// `{ origin, provider }`。ログイン画面を出し、戻ってきたコードをトークンに替えて置く。
    /// やめたら "canceled" で reject
    @objc func login(_ call: CAPPluginCall) {
        guard let origin = origin(call) else { return }
        let request = AppLoginRequest.make()
        guard let url = request.loginURL(origin: origin, provider: call.getString("provider") ?? "") else {
            call.reject("bad provider", "bad-provider")
            return
        }
        Task { @MainActor in
            let sheet = LoginSheet(window: self.bridge?.viewController?.view.window)
            self.sheet = sheet
            defer { self.sheet = nil }
            do {
                let callback = try await sheet.open(url, callbackScheme: AppLoginRequest.callbackScheme)
                let code = try request.code(from: callback)
                try await self.session.completeLogin(
                    origin: origin,
                    code: code,
                    verifier: request.verifier,
                    deviceName: UIDevice.current.name
                )
                call.resolve()
            } catch AppAuthError.canceled {
                call.reject("canceled", "canceled")
            } catch {
                call.reject("login failed", "failed")
            }
        }
    }

    /// `{ origin }` → `{ token: string | null }`。期限が近ければ更新してから返す
    @objc func accessToken(_ call: CAPPluginCall) {
        guard let origin = origin(call) else { return }
        Task {
            let token = await session.accessToken(origin: origin)
            call.resolve(["token": token as Any])
        }
    }

    /// `{ origin }`。中間サーバーのこの端末を消し、手元のトークンも消す
    @objc func logout(_ call: CAPPluginCall) {
        guard let origin = origin(call) else { return }
        Task {
            await session.logout(origin: origin)
            call.resolve()
        }
    }

    /// `{ origin }`。手元のトークンだけを消す（すべての端末からログアウト・退会のあと）
    @objc func forget(_ call: CAPPluginCall) {
        guard let origin = origin(call) else { return }
        Task {
            await session.forget(origin: origin)
            call.resolve()
        }
    }
}
