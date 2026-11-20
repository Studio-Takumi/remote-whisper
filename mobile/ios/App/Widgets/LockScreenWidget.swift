import SwiftUI
import WidgetKit

/// ロック画面のウィジェット（円。#454。spec/mobile.md 11.6）。アプリのアイコンの印だけ。押すとアプリを開く
struct LockScreenWidget: Widget {
    static let kind = "AppIconLockScreenWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: LockScreenProvider()) { _ in
            LockScreenWidgetView()
        }
        .configurationDisplayName("Remote Whisper")
        .description("押すとアプリを開きます。")
        .supportedFamilies([.accessoryCircular])
    }
}

struct LockScreenEntry: TimelineEntry {
    let date: Date
}

/// 中身が変わらないので、1 つだけ
struct LockScreenProvider: TimelineProvider {
    func placeholder(in context: Context) -> LockScreenEntry {
        LockScreenEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (LockScreenEntry) -> Void) {
        completion(LockScreenEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<LockScreenEntry>) -> Void) {
        completion(Timeline(entries: [LockScreenEntry(date: Date())], policy: .never))
    }
}

struct LockScreenWidgetView: View {
    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            AppMark()
                .padding(.horizontal, 17)
        }
        .widgetURL(AppEntryRequest.open.url)
        .accessoryBackground()
    }
}

private extension View {
    /// iOS 17 からは containerBackground が要る（ロック画面は透明のまま）
    @ViewBuilder
    func accessoryBackground() -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(.clear, for: .widget)
        } else {
            self
        }
    }
}
