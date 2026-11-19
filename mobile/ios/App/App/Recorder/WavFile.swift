import Foundation

/// 録音の形式。16kHz・モノラル・16bit の PCM（サーバーのリアルタイム録音と同じ。spec/mobile.md 11.3）
struct WavFormat: Equatable {
    var sampleRate: Int = 16000
    var channels: Int = 1
    var bitsPerSample: Int = 16

    static let speech = WavFormat()

    var blockAlign: Int { channels * bitsPerSample / 8 }
    var byteRate: Int { sampleRate * blockAlign }
}

/// WAV の 44 バイトのヘッダー（RIFF・fmt・data の 3 つのチャンクだけ）
enum WavHeader {
    static let size = 44

    static func bytes(format: WavFormat, dataSize: Int) -> Data {
        var data = Data(capacity: size)
        data.append(contentsOf: Array("RIFF".utf8))
        data.appendLE(UInt32(clamping: 36 + dataSize))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.appendLE(UInt32(16))
        data.appendLE(UInt16(1)) // PCM
        data.appendLE(UInt16(format.channels))
        data.appendLE(UInt32(format.sampleRate))
        data.appendLE(UInt32(format.byteRate))
        data.appendLE(UInt16(format.blockAlign))
        data.appendLE(UInt16(format.bitsPerSample))
        data.append(contentsOf: Array("data".utf8))
        data.appendLE(UInt32(clamping: dataSize))
        return data
    }

    /// ファイルの大きさから、音声のバイト数を出す（ブロックの途中で切れた端は捨てる）
    static func dataSize(fileSize: Int, format: WavFormat) -> Int {
        let raw = max(0, fileSize - size)
        return raw - raw % format.blockAlign
    }

    static func duration(dataSize: Int, format: WavFormat) -> Double {
        Double(dataSize) / Double(format.byteRate)
    }

    /// ヘッダーに書いてある data の長さ。読めなければ nil
    static func declaredDataSize(of header: Data) -> Int? {
        guard header.count >= size,
              header.prefix(4) == Data("RIFF".utf8),
              header[header.startIndex + 36 ..< header.startIndex + 40] == Data("data".utf8)
        else { return nil }
        return Int(header.readLE32(at: 40))
    }
}

/// 録音しながら少しずつ書く。ヘッダーの長さは `headerInterval` 秒分ごとに直すので、
/// アプリが落とされても、最後に直したところまでは普通の WAV として読める（残りは `WavRepair` で直す）
final class WavWriter {
    let url: URL
    let format: WavFormat
    private let handle: FileHandle
    private(set) var dataSize = 0
    private var dataSizeInHeader = 0
    private let headerIntervalBytes: Int

    init(url: URL, format: WavFormat = .speech, headerInterval: Double = 5) throws {
        self.url = url
        self.format = format
        headerIntervalBytes = max(format.blockAlign, Int(headerInterval * Double(format.byteRate)))
        guard FileManager.default.createFile(atPath: url.path, contents: WavHeader.bytes(format: format, dataSize: 0)) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: url.path])
        }
        handle = try FileHandle(forWritingTo: url)
        try handle.seekToEnd()
    }

    var seconds: Double { WavHeader.duration(dataSize: dataSize, format: format) }

    func append(_ pcm: Data) throws {
        guard !pcm.isEmpty else { return }
        try handle.write(contentsOf: pcm)
        dataSize += pcm.count
        if dataSize - dataSizeInHeader >= headerIntervalBytes {
            try updateHeader()
        }
    }

    func updateHeader() throws {
        let header = WavHeader.bytes(format: format, dataSize: dataSize)
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: header)
        try handle.seekToEnd()
        dataSizeInHeader = dataSize
    }

    func close() throws {
        try updateHeader()
        try handle.synchronize()
        try handle.close()
    }
}

/// 落とされたなどで、ヘッダーの長さがファイルの大きさと合わない WAV を直す
enum WavRepair {
    /// 直したら true。WAV でない・直すところがないなら false
    @discardableResult
    static func repairIfNeeded(url: URL, format: WavFormat = .speech) throws -> Bool {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        let header = try handle.read(upToCount: WavHeader.size) ?? Data()
        guard let declared = WavHeader.declaredDataSize(of: header) else { return false }
        let fileSize = Int(try handle.seekToEnd())
        let actual = WavHeader.dataSize(fileSize: fileSize, format: format)
        guard declared != actual else { return false }
        try handle.seek(toOffset: 0)
        try handle.write(contentsOf: WavHeader.bytes(format: format, dataSize: actual))
        // ブロックの途中で切れた端は捨てる
        try handle.truncate(atOffset: UInt64(WavHeader.size + actual))
        return true
    }
}

private extension Data {
    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var le = value.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }

    func readLE32(at offset: Int) -> UInt32 {
        let start = startIndex + offset
        return self[start ..< start + 4].enumerated().reduce(UInt32(0)) { acc, item in
            acc | UInt32(item.element) << (8 * UInt32(item.offset))
        }
    }
}
