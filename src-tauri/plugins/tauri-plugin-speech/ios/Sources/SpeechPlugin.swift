import AVFoundation
import Speech
import Tauri
import UIKit
import WebKit

struct StartArgs: Decodable {
  let locale: String?
  let onEvent: Channel  // receives { text, isFinal } per partial/final result
}

struct ResultEvent: Encodable {
  let text: String
  let isFinal: Bool
  var error: String? = nil
}

class SpeechPlugin: Plugin {
  private let audioEngine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?

  // Request both speech-recognition and microphone authorization.
  @objc public func requestPermission(_ invoke: Invoke) {
    SFSpeechRecognizer.requestAuthorization { status in
      let speechOk = status == .authorized
      AVAudioSession.sharedInstance().requestRecordPermission { micOk in
        invoke.resolve(["granted": speechOk && micOk])
      }
    }
  }

  // Start (cold) or re-arm (warm) recognition. The JS layer calls this again after
  // every manual edit / caret move / isFinal to drop the stale cumulative hypothesis.
  // A WARM re-arm must NOT touch the audio engine / tap / session: stopping and
  // immediately restarting AVAudioEngine on the same bus reliably throws, which used
  // to surface as an error event → JS stopped recording (mic vanished on every edit).
  // So we keep the engine running across re-arms and only swap the recognition task.
  @objc public func startRecognition(_ invoke: Invoke) {
    let args: StartArgs
    do { args = try invoke.parseArgs(StartArgs.self) } catch {
      invoke.reject("invalid args: \(error)"); return
    }

    let locale = Locale(identifier: args.locale ?? "zh-CN")
    guard let recognizer = SFSpeechRecognizer(locale: locale), recognizer.isAvailable else {
      invoke.reject("recognizer unavailable for locale \(locale.identifier)"); return
    }
    self.recognizer = recognizer

    // Drop only the previous task — leave the engine alone for a warm re-arm.
    task?.cancel()
    task = nil

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    self.request = request

    if !audioEngine.isRunning {
      // Cold start: configure session + tap + engine exactly once per dictation run.
      do {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: .duckOthers)
        try session.setActive(true, options: .notifyOthersOnDeactivation)
      } catch {
        invoke.reject("audio session error: \(error)"); return
      }
      let input = audioEngine.inputNode
      // Append to the CURRENT request so a warm re-arm's new request keeps receiving audio.
      input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
        self?.request?.append(buffer)
      }
      audioEngine.prepare()
      do { try audioEngine.start() } catch {
        invoke.reject("audio engine error: \(error)"); return
      }
    }

    self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      if let result = result {
        let ev = ResultEvent(text: result.bestTranscription.formattedString, isFinal: result.isFinal)
        try? args.onEvent.send(ev)
      }
      if let error = error {
        try? args.onEvent.send(ResultEvent(text: "", isFinal: true, error: "\(error)"))
      }
      // On final/error, drop only this task — keep the engine warm so JS can re-arm
      // without an engine restart. JS owns when to actually stop (stop_recognition).
      if error != nil || (result?.isFinal ?? false) {
        self?.task?.cancel()
        self?.task = nil
      }
    }
    invoke.resolve()
  }

  @objc public func stopRecognition(_ invoke: Invoke) {
    stopInternal()
    invoke.resolve()
  }

  // Full teardown — only on an explicit stop (mic off / send), never on re-arm.
  private func stopInternal() {
    if audioEngine.isRunning {
      audioEngine.stop()
      audioEngine.inputNode.removeTap(onBus: 0)
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    task?.cancel()
    request = nil
    task = nil
  }
}

@_cdecl("init_plugin_speech")
func initPlugin() -> Plugin { SpeechPlugin() }
