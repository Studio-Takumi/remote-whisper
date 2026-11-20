@testable import App
import XCTest

/// ウィジェット・App Intents からアプリを開いたときの頼みごと（#454）：ディープリンクの解釈と受け渡し
final class AppEntryRequestTests: XCTestCase {
    private func parse(_ string: String) -> AppEntryRequest? {
        AppEntryRequest(url: URL(string: string)!)
    }

    func testParsesLinks() {
        XCTAssertEqual(parse("remotewhisper://record"), .record)
        XCTAssertEqual(parse("remotewhisper://open"), .open)
        XCTAssertEqual(parse("remotewhisper://session/abc-123"), .session("abc-123"))
        XCTAssertEqual(parse("RemoteWhisper://RECORD"), .record)
    }

    func testRejectsOtherLinks() {
        XCTAssertNil(parse("https://record"))
        XCTAssertNil(parse("remotewhisper://unknown"))
        XCTAssertNil(parse("remotewhisper://record/extra"))
        XCTAssertNil(parse("remotewhisper://session"))
        XCTAssertNil(parse("remotewhisper://session/a/b"))
    }

    func testRoundTrip() {
        for request in [AppEntryRequest.record, .open, .session("3f2c0e9a-1b2c-4d5e-8f90-123456789abc")] {
            XCTAssertEqual(AppEntryRequest(url: request.url), request)
        }
        XCTAssertEqual(AppEntryRequest.record.url.absoluteString, "remotewhisper://record")
        XCTAssertEqual(AppEntryRequest.session("s1").url.absoluteString, "remotewhisper://session/s1")
    }

    func testEventForWeb() {
        XCTAssertEqual(AppEntryRequest.record.event, ["kind": "record"])
        XCTAssertEqual(AppEntryRequest.session("s1").event, ["kind": "session", "sessionId": "s1"])
        // アプリを開くだけのものは web/ に送らない
        XCTAssertNil(AppEntryRequest.open.event)
    }
}

@MainActor
final class AppEntryInboxTests: XCTestCase {
    func testKeepsLastUntilReceiverIsSet() {
        let inbox = AppEntryInbox()
        inbox.deliver(.open)
        inbox.deliver(.record)
        var received: [AppEntryRequest] = []
        inbox.receive { received.append($0) }
        XCTAssertEqual(received, [.record])
        // 渡したものは取っておかない
        var again: [AppEntryRequest] = []
        inbox.receive { again.append($0) }
        XCTAssertEqual(again, [])
    }

    func testPassesStraightToReceiver() {
        let inbox = AppEntryInbox()
        var received: [AppEntryRequest] = []
        inbox.receive { received.append($0) }
        inbox.deliver(urls: [URL(string: "https://example.com")!, URL(string: "remotewhisper://session/s1")!])
        XCTAssertEqual(received, [.session("s1")])
    }
}
