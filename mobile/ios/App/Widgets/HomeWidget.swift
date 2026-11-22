import SwiftUI
import WidgetKit

/// ホーム画面のウィジェット（小。#454。spec/mobile.md 11.6。デザインは匠の Pencil の採用案）。
/// 待機中（案A）は押すと録音を始め、録音中（案B）は押すとそのセッションを開く。
/// 録音中かどうかは App Group の共有の置き場から読む。App Group を使っていなければ、いつも待機中
struct HomeWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: HomeWidgetStore.widgetKind, provider: HomeWidgetProvider()) { entry in
            HomeWidgetView(content: entry.content)
                .widgetBackground(Palette.surface)
        }
        .configurationDisplayName("録音")
        .description("押すと録音を始めます。録音中は経過時間と直近の文字起こしを出します。")
        .supportedFamilies([.systemSmall])
    }
}

struct HomeWidgetEntry: TimelineEntry {
    let date: Date
    let content: HomeWidgetContent
}

struct HomeWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> HomeWidgetEntry {
        HomeWidgetEntry(date: Date(), content: .idle(last: nil))
    }

    func getSnapshot(in context: Context, completion: @escaping (HomeWidgetEntry) -> Void) {
        let now = Date()
        completion(HomeWidgetEntry(date: now, content: HomeWidgetTimeline.content(of: HomeWidgetStore.shared()?.read(), now: now)))
    }

    /// アプリが状態を書くたびに reloadTimelines で作り直す。それまでは作り直さない
    func getTimeline(in context: Context, completion: @escaping (Timeline<HomeWidgetEntry>) -> Void) {
        let entries = HomeWidgetTimeline.entries(of: HomeWidgetStore.shared()?.read(), now: Date())
            .map { HomeWidgetEntry(date: $0.date, content: $0.content) }
        completion(Timeline(entries: entries, policy: .never))
    }
}

struct HomeWidgetView: View {
    let content: HomeWidgetContent

    var body: some View {
        switch content {
        case let .idle(last):
            IdleView(last: last)
                .widgetURL(AppEntryRequest.record.url)
        case let .recording(recording):
            RecordingView(recording: recording)
                .widgetURL(AppEntryRequest.session(recording.sessionId).url)
        }
    }
}

// MARK: - 待機中（案A）

private struct IdleView: View {
    let last: HomeWidgetState.LastRecording?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center) {
                Text("Remote Whisper")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(Palette.sub)
                    .lineLimit(1)
                Spacer(minLength: 4)
                Image(systemName: "cloud")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(Palette.sub)
            }
            Spacer(minLength: 4)
            ZStack {
                Circle().fill(Palette.blue)
                Image(systemName: "mic")
                    .font(.system(size: 26, weight: .medium))
                    .foregroundColor(.white)
            }
            .frame(width: 64, height: 64)
            Spacer(minLength: 4)
            VStack(alignment: .leading, spacing: 2) {
                Text("録音する")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundColor(Palette.text)
                if let last {
                    let parts = HomeWidgetText.lastParts(last)
                    HStack(spacing: 0) {
                        Text(parts.name).lineLimit(1)
                        Text(parts.duration).lineLimit(1).fixedSize()
                    }
                    .font(.system(size: 11, weight: .medium))
                    .foregroundColor(Palette.sub)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - 録音中（案B）

private struct RecordingView: View {
    let recording: HomeWidgetState.Recording

    private var paused: Bool { recording.phase == .paused }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                if paused {
                    Image(systemName: "pause.fill")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Palette.amber)
                } else {
                    Circle().fill(Palette.red).frame(width: 7, height: 7)
                }
                Text(
                    timerInterval: recording.startedAt...Date.distantFuture,
                    pauseTime: recording.pausedAt,
                    countsDown: false,
                    showsHours: true
                )
                .font(.system(size: 13, weight: .bold, design: .monospaced))
                .monospacedDigit()
                .foregroundColor(paused ? Palette.amber : Palette.red)
                .multilineTextAlignment(.leading)
            }
            Spacer(minLength: 6)
            TranscriptText(
                lines: recording.lines,
                lineLimit: 3,
                perLine: 7.5,
                size: 14,
                weight: .semibold,
                newest: paused ? Palette.faint1 : Palette.text,
                older: Palette.faint1,
                lineSpacing: 2
            )
            Spacer(minLength: 6)
            HStack(spacing: 5) {
                Image(systemName: "doc.text")
                    .font(.system(size: 11, weight: .medium))
                Text(recording.title)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
            }
            .foregroundColor(Palette.sub)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

// MARK: - 背景

extension View {
    /// iOS 17 からは containerBackground（余白はシステムが付ける）。16 は自分で塗って余白を付ける
    @ViewBuilder
    func widgetBackground(_ color: Color) -> some View {
        if #available(iOS 17.0, *) {
            containerBackground(color, for: .widget)
        } else {
            padding(16).background(color)
        }
    }
}
