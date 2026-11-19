import ActivityKit
import Foundation

/// LiveActivityClient の本物（ActivityKit。iOS 16.1 から）
@available(iOS 16.1, *)
final class ActivityKitClient: LiveActivityClient {
    /// update と end は非同期なので、呼ばれた順に流す（update の前に end が終わらないように）
    private var last: Task<Void, Never>?

    var enabled: Bool {
        ActivityAuthorizationInfo().areActivitiesEnabled
    }

    func request(sessionId: String, state: RecordingActivityState) throws -> String {
        let attributes = RecordingActivityAttributes(sessionId: sessionId)
        if #available(iOS 16.2, *) {
            return try Activity.request(attributes: attributes, content: .init(state: state, staleDate: nil)).id
        }
        return try Activity.request(attributes: attributes, contentState: state).id
    }

    func update(id: String, state: RecordingActivityState) {
        guard let activity = Self.find(id) else { return }
        enqueue {
            if #available(iOS 16.2, *) {
                await activity.update(.init(state: state, staleDate: nil))
            } else {
                await activity.update(using: state)
            }
        }
    }

    func end(id: String) {
        guard let activity = Self.find(id) else { return }
        enqueue { await Self.endNow(activity) }
    }

    func endAll() {
        // 今あるものだけを終える（このあと出すものを巻き込まない）
        let activities = Activity<RecordingActivityAttributes>.activities
        guard !activities.isEmpty else { return }
        enqueue {
            for activity in activities {
                await Self.endNow(activity)
            }
        }
    }

    private func enqueue(_ work: @escaping () async -> Void) {
        let previous = last
        last = Task {
            await previous?.value
            await work()
        }
    }

    private static func find(_ id: String) -> Activity<RecordingActivityAttributes>? {
        Activity<RecordingActivityAttributes>.activities.first { $0.id == id }
    }

    /// 録音を終えたら、ロック画面にも残さない
    private static func endNow(_ activity: Activity<RecordingActivityAttributes>) async {
        if #available(iOS 16.2, *) {
            await activity.end(nil, dismissalPolicy: .immediate)
        } else {
            await activity.end(using: nil, dismissalPolicy: .immediate)
        }
    }
}
