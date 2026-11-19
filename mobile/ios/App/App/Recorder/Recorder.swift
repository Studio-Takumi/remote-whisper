import AVFoundation
import Foundation

enum RecorderError: Error {
    case permissionDenied
    case alreadyRecording
    case notRecording
    case noInput
}

/// マイクから録って、16kHz・モノラルの WAV に少しずつ書く（spec/mobile.md 11.3）。
/// AVAudioSession（.record）＋ AVAudioEngine。画面ロック中・バックグラウンドでも録れるよう、
/// Info.plist の UIBackgroundModes に audio を入れている。
/// 状態はすべて `queue` の上で変える。コールバックも `queue` から呼ぶ
final class Recorder {
    struct Status {
        let state: RecorderState
        let file: String?
        let seconds: Double
    }

    /// 状態が変わった。止まったときは録ったファイルの情報も渡す
    var onStateChange: ((RecorderState, RecorderReason, RecordingInfo?) -> Void)?
    /// 録った長さ（秒）。録っている間、1 秒ごと
    var onProgress: ((Double) -> Void)?

    private let store: RecordingStore
    private let session = AVAudioSession.sharedInstance()
    private let queue = DispatchQueue(label: "dev.studiotakumi.remotewhisper.recorder")
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!

    private var state: RecorderState = .idle
    private var engine: AVAudioEngine?
    private var writer: WavWriter?
    private var timer: DispatchSourceTimer?
    private var observers: [NSObjectProtocol] = []

    init(store: RecordingStore) {
        self.store = store
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
                self?.queue.async { self?.handleInterruption(note) }
            },
            center.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
                self?.queue.async { self?.handle(.mediaServicesReset) }
            },
            // イヤホンを抜いた・挿したなどで入力が変わると、エンジンは止まってこれが来る。新しい形式で作り直す
            center.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: nil) { [weak self] note in
                self?.queue.async {
                    guard let self, let changed = note.object as? AVAudioEngine, changed === self.engine else { return }
                    self.handle(.routeChanged)
                }
            },
        ]
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }

    /// 録っているファイル（ヘッダーを直す対象から外す）
    var currentFileURL: URL? { queue.sync { writer?.url } }

    func status() -> Status {
        queue.sync { Status(state: state, file: writer?.url.lastPathComponent, seconds: writer?.seconds ?? 0) }
    }

    /// 録り始める。マイクの許可をまだ聞いていなければ聞く。できたらファイル名を返す
    func start(completion: @escaping (Result<String, Error>) -> Void) {
        requestPermission { [weak self] granted in
            guard let self else { return }
            self.queue.async {
                guard granted else { return completion(.failure(RecorderError.permissionDenied)) }
                guard let transition = RecorderStateMachine.next(self.state, .start) else {
                    return completion(.failure(RecorderError.alreadyRecording))
                }
                do {
                    try self.begin()
                } catch {
                    self.teardown()
                    return completion(.failure(error))
                }
                self.apply(transition, file: nil)
                completion(.success(self.writer?.url.lastPathComponent ?? ""))
            }
        }
    }

    /// 止めて、録ったファイルの情報を返す
    func stop(completion: @escaping (Result<RecordingInfo, Error>) -> Void) {
        queue.async {
            guard let transition = RecorderStateMachine.next(self.state, .stop) else {
                return completion(.failure(RecorderError.notRecording))
            }
            let info = self.finish()
            self.apply(transition, file: info)
            if let info {
                completion(.success(info))
            } else {
                completion(.failure(RecorderError.notRecording))
            }
        }
    }

    // MARK: - 状態の移り変わり

    private func handle(_ event: RecorderEvent) {
        guard let transition = RecorderStateMachine.next(state, event) else { return }
        var info: RecordingInfo?
        switch transition.action {
        case .pause:
            stopEngine()
        case .restartEngine:
            do {
                try restartEngine()
            } catch {
                NSLog("[Recorder] エンジンを作り直せませんでした: \(error)")
                return handle(.failed)
            }
        case .finish:
            info = finish()
        case .begin, .none:
            break
        }
        apply(transition, file: info)
    }

    private func apply(_ transition: RecorderTransition, file: RecordingInfo?) {
        state = transition.to
        if state == .recording { startTimer() } else { stopTimer() }
        onStateChange?(state, transition.reason, file)
    }

    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }
        switch type {
        case .began:
            // アプリが止められていた（suspended）ことを後から知らせるものは、割り込みではない
            if let reasonRaw = info[AVAudioSessionInterruptionReasonKey] as? UInt,
               AVAudioSession.InterruptionReason(rawValue: reasonRaw) == .appWasSuspended {
                return
            }
            handle(.interruptionBegan)
        case .ended:
            let optionsRaw = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
            handle(.interruptionEnded(shouldResume: shouldResume))
        @unknown default:
            break
        }
    }

    // MARK: - ファイルとエンジン

    private func begin() throws {
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true)
        writer = try WavWriter(url: store.newFileURL())
        try startEngine()
    }

    private func finish() -> RecordingInfo? {
        stopEngine()
        guard let writer else { return nil }
        self.writer = nil
        do {
            try writer.close()
        } catch {
            NSLog("[Recorder] ファイルを閉じられませんでした: \(error)")
        }
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        return try? store.info(for: writer.url)
    }

    private func teardown() {
        stopEngine()
        if let writer {
            try? writer.close()
            try? FileManager.default.removeItem(at: writer.url)
        }
        writer = nil
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func restartEngine() throws {
        stopEngine()
        try session.setCategory(.record, mode: .default, options: [])
        try session.setActive(true)
        try startEngine()
    }

    private func startEngine() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let converter = AVAudioConverter(from: inputFormat, to: outputFormat)
        else { throw RecorderError.noInput }
        converter.downmix = true
        let outputFormat = self.outputFormat
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            // 変換はこのスレッドで済ませ（buffer はこの中でしか使えない）、書くのは queue で
            guard let pcm = Recorder.convert(buffer, with: converter, to: outputFormat) else { return }
            self?.queue.async { self?.write(pcm) }
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw error
        }
        self.engine = engine
    }

    private func stopEngine() {
        guard let engine else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        self.engine = nil
    }

    private func write(_ pcm: Data) {
        guard state == .recording, let writer else { return }
        do {
            try writer.append(pcm)
        } catch {
            NSLog("[Recorder] 書き込めませんでした: \(error)")
            handle(.failed)
        }
    }

    private static func convert(_ buffer: AVAudioPCMBuffer, with converter: AVAudioConverter, to format: AVAudioFormat) -> Data? {
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 32
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, inputStatus in
            if fed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, output.frameLength > 0, let channel = output.int16ChannelData else { return nil }
        return Data(bytes: channel[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
    }

    // MARK: - 経過秒数

    private func startTimer() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self, let writer = self.writer else { return }
            self.onProgress?(writer.seconds)
        }
        timer.resume()
        self.timer = timer
    }

    private func stopTimer() {
        timer?.cancel()
        timer = nil
    }

    // MARK: - マイクの許可

    private func requestPermission(_ completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: completion(true)
            case .denied: completion(false)
            default: AVAudioApplication.requestRecordPermission(completionHandler: completion)
            }
        } else {
            switch session.recordPermission {
            case .granted: completion(true)
            case .denied: completion(false)
            default: session.requestRecordPermission(completion)
            }
        }
    }
}
