import Foundation

/// アプリのトークンを持ち、期限が近ければ更新して渡す（#441）。
/// 更新トークンはこの中（と Keychain）にだけ置き、web/ には短い期限のアクセストークンだけを渡す
actor AppAuthSession {
    private let store: AppTokenStore
    private let client: AppAuthClient
    private let now: () -> Date
    /// 同じオリジンの更新は 1 つずつ（更新トークンは使うたびに替わるので、2 つ同時に使うと片方が断られる）
    private var refreshing: [RelayOrigin: Task<AppTokens?, Never>] = [:]

    /// 期限までこれより短ければ、先に更新する
    static let refreshMargin: TimeInterval = 60

    init(store: AppTokenStore, client: AppAuthClient, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.client = client
        self.now = now
    }

    private var nowMs: Double { now().timeIntervalSince1970 * 1000 }

    /// ログイン画面から戻ってきたコードをトークンに替えて置く
    func completeLogin(origin: RelayOrigin, code: String, verifier: String, deviceName: String) async throws {
        let tokens = try await client.exchange(origin: origin, code: code, verifier: verifier, deviceName: deviceName)
        store.save(tokens, for: origin)
    }

    /// 使えるアクセストークン。ログインしていない・更新トークンが切れた・断られたときは nil。
    /// 断られた（401 など）ときは手元のトークンを消す。つながらないときは消さない（あとでまた試す）
    func accessToken(origin: RelayOrigin) async -> String? {
        guard let tokens = store.load(origin) else { return nil }
        if tokens.accessExpiresAt - Self.refreshMargin * 1000 > nowMs {
            return tokens.accessToken
        }
        if tokens.refreshExpiresAt <= nowMs {
            store.remove(origin)
            return nil
        }
        if let running = refreshing[origin] {
            return await running.value?.accessToken
        }
        let task = Task { () -> AppTokens? in
            do {
                let next = try await client.refresh(origin: origin, refreshToken: tokens.refreshToken)
                store.save(next, for: origin)
                return next
            } catch AppAuthError.network {
                return nil
            } catch {
                store.remove(origin)
                return nil
            }
        }
        refreshing[origin] = task
        let result = await task.value
        refreshing[origin] = nil
        return result?.accessToken
    }

    /// ログインしているか（トークンを持っているか）
    func hasTokens(origin: RelayOrigin) -> Bool {
        store.load(origin) != nil
    }

    /// ログアウト。中間サーバーのその端末を消し（失敗しても）、手元のトークンも消す
    func logout(origin: RelayOrigin) async {
        guard let tokens = store.load(origin) else { return }
        store.remove(origin)
        await client.logout(origin: origin, refreshToken: tokens.refreshToken)
    }

    /// 手元のトークンだけを消す（すべての端末からログアウト・退会のあと。中間サーバーではもう消えている）
    func forget(origin: RelayOrigin) {
        store.remove(origin)
    }
}
