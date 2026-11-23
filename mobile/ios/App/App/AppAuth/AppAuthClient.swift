import Foundation

/// 中間サーバーに JSON を POST する（テストでは差し替える）。返すのは HTTP のステータスと本文
protocol AppAuthTransport {
    func post(_ url: URL, json: [String: String]) async throws -> (Int, Data)
}

struct URLSessionTransport: AppAuthTransport {
    func post(_ url: URL, json: [String: String]) async throws -> (Int, Data) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: json)
        // トークンの返事をキャッシュに残さない（中間サーバーも no-store を付ける）
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        let (data, response) = try await URLSession.shared.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

/// 中間サーバーのトークンの口（/auth/app/token・/auth/app/logout。spec/cloud.md 10.7）
struct AppAuthClient {
    let transport: AppAuthTransport

    /// ログインのあとの一度だけのコードと verifier を、トークンに替える
    func exchange(origin: RelayOrigin, code: String, verifier: String, deviceName: String) async throws -> AppTokens {
        try await tokens(origin, [
            "grantType": "authorization_code",
            "code": code,
            "codeVerifier": verifier,
            "deviceName": deviceName,
        ])
    }

    /// 更新（アクセストークンも更新トークンも替わる）
    func refresh(origin: RelayOrigin, refreshToken: String) async throws -> AppTokens {
        try await tokens(origin, ["grantType": "refresh_token", "refreshToken": refreshToken])
    }

    /// その端末のログインセッションを消す（失敗しても呼ぶ側は手元のトークンを消す）
    func logout(origin: RelayOrigin, refreshToken: String) async {
        _ = try? await transport.post(origin.endpoint("/auth/app/logout"), json: ["refreshToken": refreshToken])
    }

    private func tokens(_ origin: RelayOrigin, _ body: [String: String]) async throws -> AppTokens {
        let status: Int
        let data: Data
        do {
            (status, data) = try await transport.post(origin.endpoint("/auth/app/token"), json: body)
        } catch {
            throw AppAuthError.network
        }
        guard status == 200 else { throw AppAuthError.rejected(status) }
        guard let tokens = try? JSONDecoder().decode(AppTokens.self, from: data) else {
            throw AppAuthError.rejected(status)
        }
        return tokens
    }
}
