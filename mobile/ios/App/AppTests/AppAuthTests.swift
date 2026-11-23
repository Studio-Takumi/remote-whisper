@testable import App
import XCTest

/// クラウド版のログイン（#441）：PKCE・戻ってきた URL・中間サーバーのオリジン・トークンの更新と消し方
final class AppAuthTests: XCTestCase {
    private let origin = RelayOrigin("https://rw.example")!

    // MARK: PKCE と URL

    func testChallengeIsTheS256OfTheVerifier() {
        // RFC 7636 の付録 B の値
        XCTAssertEqual(
            AppLoginRequest.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        )
    }

    func testMakeUsesFreshRandomValues() {
        let a = AppLoginRequest.make()
        let b = AppLoginRequest.make()
        XCTAssertNotEqual(a.verifier, b.verifier)
        XCTAssertNotEqual(a.state, b.state)
        XCTAssertEqual(a.verifier.count, 64)
        XCTAssertEqual(a.challenge.count, 43)
        XCTAssertEqual(a.state.count, 22)
    }

    func testLoginURLSendsOnlyTheChallenge() throws {
        let request = AppLoginRequest(verifier: "v".padding(toLength: 64, withPad: "v", startingAt: 0), state: "s".padding(toLength: 22, withPad: "s", startingAt: 0))
        let url = try XCTUnwrap(request.loginURL(origin: origin, provider: "google"))
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.host, "rw.example")
        XCTAssertEqual(components.path, "/auth/app/login/google")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items, ["challenge": request.challenge, "challenge_method": "S256", "state": request.state])
        XCTAssertFalse(url.absoluteString.contains(request.verifier))
        XCTAssertNil(request.loginURL(origin: origin, provider: "evil"))
    }

    func testCodeComesOnlyFromThisLoginsCallback() throws {
        let request = AppLoginRequest(verifier: "verifier", state: "state-1")
        XCTAssertEqual(try request.code(from: URL(string: "remotewhisper://auth/callback?code=abc&state=state-1")!), "abc")
        // ほかのログインの state・state なし・コードなし・ほかの URL
        for bad in [
            "remotewhisper://auth/callback?code=abc&state=state-2",
            "remotewhisper://auth/callback?code=abc",
            "remotewhisper://auth/callback?state=state-1",
            "remotewhisper://record?code=abc&state=state-1",
            "remotewhisper://auth/other?code=abc&state=state-1",
            "https://auth/callback?code=abc&state=state-1",
        ] {
            XCTAssertThrowsError(try request.code(from: URL(string: bad)!), bad) {
                XCTAssertEqual($0 as? AppAuthError, .badCallback, bad)
            }
        }
        XCTAssertThrowsError(try request.code(from: URL(string: "remotewhisper://auth/callback?error=access_denied&state=state-1")!)) {
            XCTAssertEqual($0 as? AppAuthError, .canceled)
        }
    }

    func testCallbackIsNotAnAppEntry() {
        // ウィジェットの入り口（AppEntryRequest）としては読まない
        XCTAssertNil(AppEntryRequest(url: URL(string: "remotewhisper://auth/callback?code=abc&state=s")!))
    }

    func testRelayOriginIsHttpsOnly() {
        XCTAssertEqual(RelayOrigin("https://RW.example/")?.key, "https://rw.example")
        XCTAssertEqual(RelayOrigin("https://rw.example:8443")?.key, "https://rw.example:8443")
        XCTAssertEqual(RelayOrigin("http://localhost:8787")?.key, "http://localhost:8787")
        for bad in ["http://rw.example", "https://rw.example/path", "https://u:p@rw.example", "https://rw.example?x=1", "capacitor://localhost", "", "rw.example"] {
            XCTAssertNil(RelayOrigin(bad), bad)
        }
    }

    // MARK: トークン

    private func tokens(_ id: String, accessIn: Double, refreshIn: Double = 86_400_000, at nowMs: Double) -> AppTokens {
        AppTokens(accessToken: "access-\(id)", accessExpiresAt: nowMs + accessIn, refreshToken: "refresh-\(id)", refreshExpiresAt: nowMs + refreshIn)
    }

    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private var nowMs: Double { now.timeIntervalSince1970 * 1000 }

    func testLoginExchangesTheCodeWithTheVerifier() async throws {
        let store = MemoryTokenStore()
        let transport = FakeTransport { _, _ in (200, try JSONEncoder().encode(self.tokens("1", accessIn: 3_600_000, at: self.nowMs))) }
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: transport), now: { self.now })
        try await session.completeLogin(origin: origin, code: "code", verifier: "verifier", deviceName: "iPhone")
        XCTAssertEqual(transport.calls.first?.0.absoluteString, "https://rw.example/auth/app/token")
        XCTAssertEqual(transport.calls.first?.1, ["grantType": "authorization_code", "code": "code", "codeVerifier": "verifier", "deviceName": "iPhone"])
        let token = await session.accessToken(origin: origin)
        XCTAssertEqual(token, "access-1")
        XCTAssertEqual(transport.calls.count, 1)
    }

    func testRejectedLoginStoresNothing() async {
        let store = MemoryTokenStore()
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: FakeTransport { _, _ in (400, Data()) }), now: { self.now })
        do {
            try await session.completeLogin(origin: origin, code: "code", verifier: "verifier", deviceName: "iPhone")
            XCTFail("should throw")
        } catch {
            XCTAssertEqual(error as? AppAuthError, .rejected(400))
        }
        XCTAssertTrue(store.items.isEmpty)
    }

    func testRefreshesWhenTheAccessTokenIsAboutToExpire() async {
        let store = MemoryTokenStore()
        store.save(tokens("old", accessIn: 30_000, at: nowMs), for: origin)
        let transport = FakeTransport { _, _ in (200, try JSONEncoder().encode(self.tokens("new", accessIn: 3_600_000, at: self.nowMs))) }
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: transport), now: { self.now })
        let token = await session.accessToken(origin: origin)
        XCTAssertEqual(token, "access-new")
        XCTAssertEqual(transport.calls.first?.1, ["grantType": "refresh_token", "refreshToken": "refresh-old"])
        XCTAssertEqual(store.load(origin)?.refreshToken, "refresh-new")
    }

    func testConcurrentCallsRefreshOnce() async {
        let store = MemoryTokenStore()
        store.save(tokens("old", accessIn: 0, at: nowMs), for: origin)
        let transport = FakeTransport { _, _ in
            try await Task.sleep(nanoseconds: 50_000_000)
            return (200, try JSONEncoder().encode(self.tokens("new", accessIn: 3_600_000, at: self.nowMs)))
        }
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: transport), now: { self.now })
        async let a = session.accessToken(origin: origin)
        async let b = session.accessToken(origin: origin)
        let results = await [a, b]
        XCTAssertEqual(results, ["access-new", "access-new"])
        XCTAssertEqual(transport.calls.count, 1)
    }

    func testRejectedRefreshForgetsTheTokens() async {
        let store = MemoryTokenStore()
        store.save(tokens("old", accessIn: 0, at: nowMs), for: origin)
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: FakeTransport { _, _ in (401, Data()) }), now: { self.now })
        let token = await session.accessToken(origin: origin)
        XCTAssertNil(token)
        XCTAssertNil(store.load(origin))
    }

    func testNetworkErrorKeepsTheTokensForLater() async {
        let store = MemoryTokenStore()
        store.save(tokens("old", accessIn: 0, at: nowMs), for: origin)
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: FakeTransport { _, _ in throw URLError(.notConnectedToInternet) }), now: { self.now })
        let token = await session.accessToken(origin: origin)
        XCTAssertNil(token)
        XCTAssertEqual(store.load(origin)?.refreshToken, "refresh-old")
    }

    func testExpiredRefreshTokenIsForgottenWithoutCallingTheRelay() async {
        let store = MemoryTokenStore()
        store.save(tokens("old", accessIn: -10, refreshIn: -10, at: nowMs), for: origin)
        let transport = FakeTransport { _, _ in (200, Data()) }
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: transport), now: { self.now })
        let token = await session.accessToken(origin: origin)
        XCTAssertNil(token)
        XCTAssertNil(store.load(origin))
        XCTAssertTrue(transport.calls.isEmpty)
    }

    func testLogoutForgetsEvenWhenTheRelayIsUnreachable() async {
        let store = MemoryTokenStore()
        store.save(tokens("1", accessIn: 3_600_000, at: nowMs), for: origin)
        let other = RelayOrigin("https://rw-dev.example")!
        store.save(tokens("2", accessIn: 3_600_000, at: nowMs), for: other)
        let transport = FakeTransport { _, _ in throw URLError(.notConnectedToInternet) }
        let session = AppAuthSession(store: store, client: AppAuthClient(transport: transport), now: { self.now })
        await session.logout(origin: origin)
        XCTAssertNil(store.load(origin))
        XCTAssertEqual(transport.calls.first?.0.absoluteString, "https://rw.example/auth/app/logout")
        XCTAssertEqual(transport.calls.first?.1, ["refreshToken": "refresh-1"])
        // ほかのオリジンのトークンは残す
        XCTAssertNotNil(store.load(other))
    }
}

/// Keychain の代わり（署名なしのシミュレーターのテストでは Keychain が使えないことがあるため）
private final class MemoryTokenStore: AppTokenStore {
    private(set) var items: [RelayOrigin: AppTokens] = [:]

    func load(_ origin: RelayOrigin) -> AppTokens? { items[origin] }
    func save(_ tokens: AppTokens, for origin: RelayOrigin) { items[origin] = tokens }
    func remove(_ origin: RelayOrigin) { items[origin] = nil }
}

/// 中間サーバーの代わり。呼ばれた URL と本文を覚える
private final class FakeTransport: AppAuthTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [(URL, [String: String])] = []
    private let respond: (URL, [String: String]) async throws -> (Int, Data)

    init(_ respond: @escaping (URL, [String: String]) async throws -> (Int, Data)) {
        self.respond = respond
    }

    var calls: [(URL, [String: String])] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    private func record(_ url: URL, _ json: [String: String]) {
        lock.lock()
        defer { lock.unlock() }
        recorded.append((url, json))
    }

    func post(_ url: URL, json: [String: String]) async throws -> (Int, Data) {
        record(url, json)
        return try await respond(url, json)
    }
}
