import Foundation

/// アプリのトークンを持ち、期限が近ければ更新して渡す（#441）。
/// 更新トークンはこの中（と Keychain）にだけ置き、web/ には短い期限のアクセストークンだけを渡す。
///
/// actor は await のところでほかの呼び出しに割り込まれる。更新の途中に logout・forget・completeLogin が来ても、
/// 古い更新の結果で書き戻さないよう、オリジンごとの世代の番号で見分ける（logout・forget・completeLogin で進める）。
/// logout・forget・completeLogin は、進行中の更新が終わるのを待ってから読み書きする
actor AppAuthSession {
    private let store: AppTokenStore
    private let client: AppAuthClient
    private let now: () -> Date
    /// 同じオリジンの更新は 1 つずつ（更新トークンは使うたびに替わるので、2 つ同時に使うと片方が断られる）
    private var refreshing: [RelayOrigin: Task<AppTokens?, Never>] = [:]
    /// オリジンごとの世代。ログアウト・忘れる・ログインし直すたびに進める
    private var generation: [RelayOrigin: Int] = [:]

    /// 期限までこれより短ければ、先に更新する
    static let refreshMargin: TimeInterval = 60

    init(store: AppTokenStore, client: AppAuthClient, now: @escaping () -> Date = Date.init) {
        self.store = store
        self.client = client
        self.now = now
    }

    private var nowMs: Double { now().timeIntervalSince1970 * 1000 }

    /// 進行中の更新が終わるのを待ち、世代を進める（これより前に始めた更新の結果は捨てられる）
    private func settle(_ origin: RelayOrigin) async -> Int {
        if let running = refreshing[origin] {
            _ = await running.value
        }
        let next = generation[origin, default: 0] + 1
        generation[origin] = next
        return next
    }

    /// ログイン画面から戻ってきたコードをトークンに替えて置く。
    /// 替えている途中にログアウトなどが来たら、置かずに中間サーバーのその端末も消す
    func completeLogin(origin: RelayOrigin, code: String, verifier: String, deviceName: String) async throws {
        let mine = await settle(origin)
        // 前のログインのトークンが残っていれば、先に手元から消し（このあと更新に使われないように）、中間サーバーの端末も消す。
        // 上書きするだけだと、前の端末がサーバーに期限まで残るため
        if let old = store.load(origin) {
            store.remove(origin)
            await client.logout(origin: origin, refreshToken: old.refreshToken)
        }
        let tokens = try await client.exchange(origin: origin, code: code, verifier: verifier, deviceName: deviceName)
        guard generation[origin] == mine else {
            await client.logout(origin: origin, refreshToken: tokens.refreshToken)
            throw AppAuthError.canceled
        }
        store.save(tokens, for: origin)
    }

    /// 使えるアクセストークン。ログインしていない・更新トークンが切れた・断られたときは nil。
    /// 断られた（401 など）ときは手元のトークンを消す。つながらないときは消さない（あとでまた試す）
    func accessToken(origin: RelayOrigin) async -> String? {
        await access(origin: origin)?.accessToken
    }

    /// accessToken と同じで、置いているトークン全体を返す（web にアクセストークンの期限も渡すため。
    /// 呼ぶ側は更新トークンを外へ出さない）
    func access(origin: RelayOrigin) async -> AppTokens? {
        if let running = refreshing[origin] {
            return await running.value
        }
        guard let tokens = store.load(origin) else { return nil }
        if tokens.accessExpiresAt - Self.refreshMargin * 1000 > nowMs {
            return tokens
        }
        if tokens.refreshExpiresAt <= nowMs {
            store.remove(origin)
            return nil
        }
        let started = generation[origin, default: 0]
        let task = Task { () -> AppTokens? in
            let result: AppTokens?
            do {
                let next = try await client.refresh(origin: origin, refreshToken: tokens.refreshToken)
                if generation[origin, default: 0] == started {
                    store.save(next, for: origin)
                    result = next
                } else {
                    // 途中でログアウトなどされた。新しいトークンは置かず、中間サーバーのその端末も消す
                    await client.logout(origin: origin, refreshToken: next.refreshToken)
                    result = nil
                }
            } catch AppAuthError.network {
                result = nil
            } catch {
                if generation[origin, default: 0] == started {
                    store.remove(origin)
                }
                result = nil
            }
            refreshing[origin] = nil
            return result
        }
        refreshing[origin] = task
        return await task.value
    }

    /// ログインしているか（トークンを持っているか）
    func hasTokens(origin: RelayOrigin) -> Bool {
        store.load(origin) != nil
    }

    /// ログアウト。進行中の更新を待ってから、中間サーバーのその端末を消し（失敗しても）、手元のトークンも消す
    func logout(origin: RelayOrigin) async {
        _ = await settle(origin)
        guard let tokens = store.load(origin) else { return }
        store.remove(origin)
        await client.logout(origin: origin, refreshToken: tokens.refreshToken)
    }

    /// 手元のトークンだけを消す（すべての端末からログアウト・退会のあと。中間サーバーではもう消えている）
    func forget(origin: RelayOrigin) async {
        _ = await settle(origin)
        store.remove(origin)
    }
}
