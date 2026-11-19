import Foundation

/// 録ったファイル 1 つの情報（JS の `RecordingFile`。spec/mobile.md 11.3）
struct RecordingInfo: Equatable {
    let name: String
    let durationSec: Double
    let size: Int
    let createdAt: Date
    let modifiedAt: Date

    var json: [String: Any] {
        let iso = ISO8601DateFormatter()
        return [
            "name": name,
            "durationSec": durationSec,
            "size": size,
            "createdAt": iso.string(from: createdAt),
            "modifiedAt": iso.string(from: modifiedAt),
        ]
    }
}

enum RecordingStoreError: Error, Equatable {
    case invalidName
    case notFound
}

/// 録音ファイルの置き場（アプリの Documents/recordings。ファイルアプリの「このiPhone内 → Remote Whisper」から見える）
final class RecordingStore {
    /// readRecording で 1 回に返す大きさの上限（base64 で JS に渡すので、ブリッジを詰まらせない大きさ）
    static let maxReadLength = 4 * 1024 * 1024

    let directory: URL
    private let fileManager = FileManager.default

    init(directory: URL) {
        self.directory = directory
    }

    static func documents() -> RecordingStore {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return RecordingStore(directory: docs.appendingPathComponent("recordings", isDirectory: true))
    }

    /// 新しい録音ファイルの場所（まだ作らない）
    func newFileURL(date: Date = Date()) throws -> URL {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var index = 1
        while true {
            let url = directory.appendingPathComponent(RecordingName.make(date: date, index: index))
            if !fileManager.fileExists(atPath: url.path) { return url }
            index += 1
        }
    }

    func url(for name: String) throws -> URL {
        guard RecordingName.isValid(name) else { throw RecordingStoreError.invalidName }
        let url = directory.appendingPathComponent(name)
        guard fileManager.fileExists(atPath: url.path) else { throw RecordingStoreError.notFound }
        return url
    }

    func info(for url: URL, format: WavFormat = .speech) throws -> RecordingInfo {
        let attrs = try fileManager.attributesOfItem(atPath: url.path)
        let size = (attrs[.size] as? NSNumber)?.intValue ?? 0
        let modified = attrs[.modificationDate] as? Date ?? Date()
        let created = attrs[.creationDate] as? Date ?? modified
        let dataSize = WavHeader.dataSize(fileSize: size, format: format)
        return RecordingInfo(
            name: url.lastPathComponent,
            durationSec: WavHeader.duration(dataSize: dataSize, format: format),
            size: size,
            createdAt: created,
            modifiedAt: modified
        )
    }

    /// 新しい順
    func list() throws -> [RecordingInfo] {
        guard fileManager.fileExists(atPath: directory.path) else { return [] }
        return try fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { RecordingName.isValid($0.lastPathComponent) }
            .map { try info(for: $0) }
            .sorted { ($0.createdAt, $0.name) > ($1.createdAt, $1.name) }
    }

    func delete(name: String) throws {
        try fileManager.removeItem(at: url(for: name))
    }

    /// offset バイト目から最大 length バイト（maxReadLength まで）。終わりなら空
    func read(name: String, offset: Int, length: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url(for: name))
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(max(0, offset)))
        return try handle.read(upToCount: min(max(0, length), Self.maxReadLength)) ?? Data()
    }

    /// 落とされて閉じられなかったファイルのヘッダーを直す（録音中のファイルは除く）
    func repairAll(except current: URL? = nil) {
        guard let urls = try? fileManager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) else { return }
        for url in urls where RecordingName.isValid(url.lastPathComponent) && url.standardizedFileURL != current?.standardizedFileURL {
            _ = try? WavRepair.repairIfNeeded(url: url)
        }
    }
}
