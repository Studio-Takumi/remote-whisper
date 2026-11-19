@testable import App
import XCTest

final class WavFileTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testHeaderFor16kMono16bit() {
        let header = WavHeader.bytes(format: .speech, dataSize: 32000)
        XCTAssertEqual(header.count, 44)
        XCTAssertEqual(String(decoding: header[0 ..< 4], as: UTF8.self), "RIFF")
        XCTAssertEqual(le32(header, 4), 36 + 32000)
        XCTAssertEqual(String(decoding: header[8 ..< 16], as: UTF8.self), "WAVEfmt ")
        XCTAssertEqual(le32(header, 16), 16)
        XCTAssertEqual(le16(header, 20), 1) // PCM
        XCTAssertEqual(le16(header, 22), 1) // モノラル
        XCTAssertEqual(le32(header, 24), 16000)
        XCTAssertEqual(le32(header, 28), 32000) // byteRate
        XCTAssertEqual(le16(header, 32), 2) // blockAlign
        XCTAssertEqual(le16(header, 34), 16)
        XCTAssertEqual(String(decoding: header[36 ..< 40], as: UTF8.self), "data")
        XCTAssertEqual(le32(header, 40), 32000)
        XCTAssertEqual(WavHeader.declaredDataSize(of: header), 32000)
    }

    func testDurationFromFileSize() {
        XCTAssertEqual(WavHeader.dataSize(fileSize: 44 + 32001, format: .speech), 32000)
        XCTAssertEqual(WavHeader.dataSize(fileSize: 10, format: .speech), 0)
        XCTAssertEqual(WavHeader.duration(dataSize: 48000, format: .speech), 1.5)
    }

    func testWriterUpdatesHeaderPeriodicallyAndOnClose() throws {
        let url = dir.appendingPathComponent("a.wav")
        let writer = try WavWriter(url: url, headerInterval: 1)
        try writer.append(Data(count: 16000)) // 0.5 秒。まだヘッダーは直さない
        XCTAssertEqual(try declared(url), 0)
        try writer.append(Data(count: 16000)) // 1 秒たまったので直す
        XCTAssertEqual(try declared(url), 32000)
        try writer.append(Data(count: 3200))
        XCTAssertEqual(writer.seconds, 1.1, accuracy: 1e-9)
        try writer.close()
        XCTAssertEqual(try declared(url), 35200)
        XCTAssertEqual(try Data(contentsOf: url).count, 44 + 35200)
    }

    func testRepairFixesAFileLeftOpen() throws {
        let url = dir.appendingPathComponent("b.wav")
        let writer = try WavWriter(url: url, headerInterval: 60)
        try writer.append(Data(count: 6401)) // ブロックの途中で切れた端（1 バイト）がある
        // close せずに落とされたとき、ヘッダーの長さは 0 のまま
        XCTAssertEqual(try declared(url), 0)
        XCTAssertTrue(try WavRepair.repairIfNeeded(url: url))
        XCTAssertEqual(try declared(url), 6400)
        XCTAssertEqual(try Data(contentsOf: url).count, 44 + 6400)
        XCTAssertFalse(try WavRepair.repairIfNeeded(url: url))
    }

    func testRepairLeavesNonWavAlone() throws {
        let url = dir.appendingPathComponent("c.wav")
        try Data("not a wav file at all, but long enough to have a header".utf8).write(to: url)
        XCTAssertFalse(try WavRepair.repairIfNeeded(url: url))
    }

    private func declared(_ url: URL) throws -> Int? {
        WavHeader.declaredDataSize(of: try Data(contentsOf: url).prefix(44))
    }

    private func le32(_ data: Data, _ offset: Int) -> Int {
        (0 ..< 4).reduce(0) { $0 | Int(data[offset + $1]) << (8 * $1) }
    }

    private func le16(_ data: Data, _ offset: Int) -> Int {
        Int(data[offset]) | Int(data[offset + 1]) << 8
    }
}
