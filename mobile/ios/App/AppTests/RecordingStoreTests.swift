@testable import App
import XCTest

final class RecordingStoreTests: XCTestCase {
    private var dir: URL!
    private var store: RecordingStore!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        store = RecordingStore(directory: dir)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testNewFileURLAvoidsExistingNames() throws {
        let date = Date()
        let first = try store.newFileURL(date: date)
        try Data().write(to: first)
        let second = try store.newFileURL(date: date)
        XCTAssertNotEqual(first, second)
        XCTAssertTrue(second.lastPathComponent.hasSuffix("-2.wav"))
    }

    func testListShowsOnlyRecordingsWithDurationAndSize() throws {
        let url = try store.newFileURL()
        let writer = try WavWriter(url: url)
        try writer.append(Data(count: 64000)) // 2 秒
        try writer.close()
        try Data("x".utf8).write(to: dir.appendingPathComponent("notes.txt"))

        let files = try store.list()
        XCTAssertEqual(files.map(\.name), [url.lastPathComponent])
        XCTAssertEqual(files[0].durationSec, 2, accuracy: 1e-9)
        XCTAssertEqual(files[0].size, 44 + 64000)
        let json = files[0].json
        XCTAssertEqual(json["name"] as? String, url.lastPathComponent)
        XCTAssertNotNil(ISO8601DateFormatter().date(from: json["createdAt"] as? String ?? ""))
        XCTAssertNotNil(ISO8601DateFormatter().date(from: json["modifiedAt"] as? String ?? ""))
    }

    func testListIsEmptyBeforeTheFirstRecording() throws {
        XCTAssertEqual(try store.list(), [])
    }

    func testReadInChunks() throws {
        let url = try store.newFileURL()
        let bytes = Data((0 ..< 100).map { UInt8($0) })
        try bytes.write(to: url)
        let name = url.lastPathComponent
        XCTAssertEqual(try store.read(name: name, offset: 0, length: 40), bytes[0 ..< 40])
        XCTAssertEqual(try store.read(name: name, offset: 90, length: 40), bytes[90 ..< 100])
        XCTAssertEqual(try store.read(name: name, offset: 100, length: 40), Data())
    }

    func testDeleteAndBadNames() throws {
        let url = try store.newFileURL()
        try Data().write(to: url)
        try store.delete(name: url.lastPathComponent)
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
        XCTAssertThrowsError(try store.delete(name: url.lastPathComponent)) {
            XCTAssertEqual($0 as? RecordingStoreError, .notFound)
        }
        XCTAssertThrowsError(try store.read(name: "../Library/secret.wav", offset: 0, length: 1)) {
            XCTAssertEqual($0 as? RecordingStoreError, .invalidName)
        }
    }

    func testRepairAllSkipsTheFileBeingRecorded() throws {
        let date = Date()
        let leftover = try store.newFileURL(date: date)
        let leftoverWriter = try WavWriter(url: leftover, headerInterval: 60)
        try leftoverWriter.append(Data(count: 3200))
        let current = try store.newFileURL(date: date)
        let currentWriter = try WavWriter(url: current, headerInterval: 60)
        try currentWriter.append(Data(count: 3200))

        store.repairAll(except: current)

        XCTAssertEqual(WavHeader.declaredDataSize(of: try Data(contentsOf: leftover)), 3200)
        XCTAssertEqual(WavHeader.declaredDataSize(of: try Data(contentsOf: current)), 0)
        try leftoverWriter.close()
        try currentWriter.close()
    }
}
