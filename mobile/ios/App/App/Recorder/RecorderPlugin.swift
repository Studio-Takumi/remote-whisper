import Capacitor
import Foundation

/// JS から呼ぶ録音のプラグイン（`Capacitor.Plugins.Recorder`。API は spec/mobile.md 11.3）。
/// 録音そのものは `Recorder`、ファイルの置き場は `RecordingStore` が持ち、このクラスは JS との受け渡しだけをする
@objc(RecorderPlugin)
public class RecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RecorderPlugin"
    public let jsName = "Recorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listRecordings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteRecording", returnType: CAPPluginReturnPromise),
    ]

    private let store = RecordingStore.documents()
    private lazy var recorder = Recorder(store: store)

    override public func load() {
        // 前に落とされたときの、閉じられなかったファイルを直す
        store.repairAll()
        recorder.onStateChange = { [weak self] state, reason, file in
            var data: [String: Any] = ["state": state.rawValue, "reason": reason.rawValue]
            if let file { data["file"] = file.json }
            self?.notifyListeners("stateChange", data: data)
        }
        recorder.onProgress = { [weak self] seconds in
            self?.notifyListeners("progress", data: ["seconds": seconds])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        recorder.start { result in
            switch result {
            case let .success(name): call.resolve(["file": name])
            case let .failure(error): Self.reject(call, error)
            }
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        recorder.stop { result in
            switch result {
            case let .success(info): call.resolve(["file": info.json])
            case let .failure(error): Self.reject(call, error)
            }
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        let status = recorder.status()
        var data: [String: Any] = ["state": status.state.rawValue, "seconds": status.seconds]
        if let file = status.file { data["file"] = file }
        call.resolve(data)
    }

    @objc func listRecordings(_ call: CAPPluginCall) {
        do {
            call.resolve(["files": try store.list().map(\.json)])
        } catch {
            Self.reject(call, error)
        }
    }

    /// ファイルを offset から最大 length バイト（既定・上限 4MiB）、base64 で返す。
    /// server.url で画面を開いているので convertFileSrc の URL は使えない（ホストに取りに行ってしまう）。
    /// web は返ってきた分をつないで File にする（spec/mobile.md 11.3）
    @objc func readRecording(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { return call.reject("name がありません", "invalid-name") }
        let offset = call.getInt("offset") ?? 0
        let length = call.getInt("length") ?? RecordingStore.maxReadLength
        do {
            let size = try store.info(for: store.url(for: name)).size
            let data = try store.read(name: name, offset: offset, length: length)
            call.resolve(["data": data.base64EncodedString(), "offset": offset, "size": size])
        } catch {
            Self.reject(call, error)
        }
    }

    @objc func deleteRecording(_ call: CAPPluginCall) {
        guard let name = call.getString("name") else { return call.reject("name がありません", "invalid-name") }
        if recorder.status().file == name {
            return call.reject("録音中のファイルは消せません", "busy")
        }
        do {
            try store.delete(name: name)
            call.resolve()
        } catch {
            Self.reject(call, error)
        }
    }

    /// エラーのコード（JS の `code`）は spec/mobile.md 11.3 の表
    private static func reject(_ call: CAPPluginCall, _ error: Error) {
        switch error {
        case RecorderError.permissionDenied: call.reject("マイクの使用が許可されていません", "permission-denied")
        case RecorderError.alreadyRecording: call.reject("すでに録音中です", "already-recording")
        case RecorderError.notRecording: call.reject("録音していません", "not-recording")
        case RecorderError.noInput: call.reject("マイクが見つかりません", "no-input")
        case RecordingStoreError.invalidName: call.reject("録音ファイルの名前ではありません", "invalid-name")
        case RecordingStoreError.notFound: call.reject("録音ファイルがありません", "not-found")
        default: call.reject(error.localizedDescription, "io", error)
        }
    }
}
