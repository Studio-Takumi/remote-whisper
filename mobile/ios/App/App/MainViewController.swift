import Capacitor
import UIKit

/// アプリの画面。Capacitor の画面に、アプリの中だけのプラグインを登録する（npm のパッケージにしないもの）。
/// 継承はこの 1 段だけにして、録音の処理は RecorderPlugin → Recorder に、Live Activity は LiveActivityPlugin に持たせる
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(RecorderPlugin())
        bridge?.registerPluginInstance(LiveActivityPlugin())
    }
}
