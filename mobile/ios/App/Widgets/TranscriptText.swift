import SwiftUI

/// 直近の文字起こしを、区切りをつなげた 1 つの文章として折り返して出す（#460。spec/mobile.md 11.5）。
/// あふれたぶんは全体の頭だけを「…」にして、最後の行数ぶんが続けて読めるようにする（切るのは TranscriptJoin.fit）。
/// いちばん新しい区切りは newest、それより前は older の色にする。
/// ライブアクティビティとホーム画面のウィジェットで同じ出し方にするために、ここに 1 つだけ置く
struct TranscriptText: View {
    let lines: [String]
    let lineLimit: Int
    /// 1 行に入る幅の見積もり（全角の文字数。端末で違う幅に収まるよう、狭いほうに寄せる）
    let perLine: Double
    let size: CGFloat
    let weight: Font.Weight
    let newest: Color
    let older: Color
    var lineSpacing: CGFloat = 0

    var body: some View {
        text
            .font(.system(size: size, weight: weight))
            .lineSpacing(lineSpacing)
            // 見積もりが外れても、いちばん新しい末尾が省略されないよう、少し縮めて収める。文字サイズの設定で大きくなりすぎないよう、上限も決める
            .minimumScaleFactor(0.8)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
            .lineLimit(lineLimit)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var text: Text {
        var result = Text("")
        let fitted = TranscriptJoin.fit(lines, budget: TranscriptJoin.budget(lines: lineLimit, perLine: perLine))
        for (index, piece) in fitted.enumerated() {
            result = result + Text(piece).foregroundColor(index == fitted.count - 1 ? newest : older)
        }
        return result
    }
}
