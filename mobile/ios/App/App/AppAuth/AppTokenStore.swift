import Foundation
import Security

/// 中間サーバーからもらったトークン（#441）。時刻は UNIX ミリ秒（中間サーバーの返事のまま）
struct AppTokens: Codable, Equatable {
    let accessToken: String
    let accessExpiresAt: Double
    let refreshToken: String
    let refreshExpiresAt: Double
}

/// トークンの置き場所。本物は Keychain、テストではメモリ
protocol AppTokenStore: AnyObject {
    func load(_ origin: RelayOrigin) -> AppTokens?
    func save(_ tokens: AppTokens, for origin: RelayOrigin)
    func remove(_ origin: RelayOrigin)
}

/// Keychain に置く（オリジンごとに 1 つ）。この端末だけ・最初のロック解除のあと読める
/// （画面ロック中の録音でも、つなぎ直すときに読めるように。iCloud のキーチェーンには入れない）
final class KeychainTokenStore: AppTokenStore {
    private let service = "dev.studiotakumi.remotewhisper.appAuth"

    private func query(_ origin: RelayOrigin) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: origin.key,
        ]
    }

    func load(_ origin: RelayOrigin) -> AppTokens? {
        var q = query(origin)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return try? JSONDecoder().decode(AppTokens.self, from: data)
    }

    /// 先に書き換えを試し、まだなければ足す（消してから足すと、その間に失敗したときにトークンを失うため）
    func save(_ tokens: AppTokens, for origin: RelayOrigin) {
        guard let data = try? JSONEncoder().encode(tokens) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(origin) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            let add = query(origin).merging(attributes) { $1 }
            status = SecItemAdd(add as CFDictionary, nil)
        }
        if status != errSecSuccess {
            print("[AppAuth] could not save the tokens: \(status)")
        }
    }

    func remove(_ origin: RelayOrigin) {
        SecItemDelete(query(origin) as CFDictionary)
    }

    /// iOS の Keychain はアプリを消しても残る。入れ直して初めて起動したとき（UserDefaults の印がないとき）に、
    /// 前に入れていたときのトークンを全部消す（入れ直したらログインし直す）
    func clearIfReinstalled(defaults: UserDefaults = .standard) {
        let key = "RWAppAuthInstalled"
        guard !defaults.bool(forKey: key) else { return }
        let all: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service]
        SecItemDelete(all as CFDictionary)
        defaults.set(true, forKey: key)
    }
}
