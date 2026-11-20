import SwiftUI

/// アプリのアイコンの印（「>」と波形とカーソル。web/public/app-icon.svg）。ロック画面の円に使う。
/// 形は Pencil の採用案（38×28）のまま、大きさに合わせて伸ばす。色は foregroundStyle に従う
struct AppMark: View {
    private static let size = CGSize(width: 38, height: 28)

    var body: some View {
        GeometryReader { geometry in
            let scale = min(geometry.size.width / Self.size.width, geometry.size.height / Self.size.height)
            ZStack(alignment: .topLeading) {
                Chevron()
                    .stroke(style: StrokeStyle(lineWidth: 4.685 * scale, lineCap: .round, lineJoin: .round))
                Bars()
            }
            .frame(width: Self.size.width * scale, height: Self.size.height * scale)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(Self.size, contentMode: .fit)
    }

    /// 「>」（線で描く）
    private struct Chevron: Shape {
        func path(in rect: CGRect) -> Path {
            let sx = rect.width / AppMark.size.width
            let sy = rect.height / AppMark.size.height
            let x = 2.342, y = 4.164, w = 7.808, h = 17.699
            var path = Path()
            path.move(to: CGPoint(x: x * sx, y: y * sy))
            path.addLine(to: CGPoint(x: (x + w) * sx, y: (y + h / 2) * sy))
            path.addLine(to: CGPoint(x: x * sx, y: (y + h) * sy))
            return path
        }
    }

    /// 波形の 3 本とカーソル（塗る）
    private struct Bars: Shape {
        private static let rects: [(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat, r: CGFloat)] = [
            (14.055, 8.329, 3.644, 9.370, 1.822),
            (20.301, 2.082, 3.644, 21.863, 1.822),
            (26.548, 5.726, 3.644, 14.575, 1.822),
            (32.795, 0, 5.205, 26.027, 1.041),
        ]

        func path(in rect: CGRect) -> Path {
            let sx = rect.width / AppMark.size.width
            let sy = rect.height / AppMark.size.height
            var path = Path()
            for r in Self.rects {
                path.addRoundedRect(
                    in: CGRect(x: r.x * sx, y: r.y * sy, width: r.w * sx, height: r.h * sy),
                    cornerSize: CGSize(width: r.r * sx, height: r.r * sy)
                )
            }
            return path
        }
    }
}
