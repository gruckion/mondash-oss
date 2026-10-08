import ExpoModulesCore
import SafariServices

public class ClaudePhoneAuthModule: Module {
  private var flow: ClaudePhoneLogin?

  public func definition() -> ModuleDefinition {
    Name("ClaudePhoneAuth")
    AsyncFunction("signIn") { (browserUrl: URL, callbackEndpoint: URL, oauthUrl: URL, promise: Promise) in
      guard self.flow == nil, let parent = self.appContext?.utilities?.currentViewController() else {
        promise.reject("SIGN_IN_UNAVAILABLE", "Claude sign-in is already open or cannot be presented.")
        return
      }
      do {
        let flow = try ClaudePhoneLogin(parent: parent, browserUrl: browserUrl, endpoint: callbackEndpoint, oauthUrl: oauthUrl) { [weak self] result in
          self?.flow = nil
          switch result {
          case .success(let connected): promise.resolve(connected)
          case .failure(let error): promise.reject("CLAUDE_SIGN_IN", error.localizedDescription)
          }
        }
        self.flow = flow
        flow.start()
      } catch { promise.reject("CLAUDE_SIGN_IN", error.localizedDescription) }
    }.runOnQueue(.main)
    OnDestroy { DispatchQueue.main.async { self.flow?.cancel() } }
  }
}

private final class ClaudePhoneLogin: NSObject, SFSafariViewControllerDelegate {
  private let parent: UIViewController
  private let browser: SFSafariViewController
  private var relay: ClaudeCallbackRelay!
  private let completion: (Result<Bool, Error>) -> Void
  private var completed = false

  init(parent: UIViewController, browserUrl: URL, endpoint: URL, oauthUrl: URL, completion: @escaping (Result<Bool, Error>) -> Void) throws {
    let oauth = URLComponents(url: oauthUrl, resolvingAgainstBaseURL: false)
    guard oauthUrl.scheme == "https", ["claude.com", "claude.ai"].contains(oauthUrl.host ?? ""),
      let redirect = oauth?.queryItems?.first(where: { $0.name == "redirect_uri" })?.value,
      let callback = URLComponents(string: redirect), callback.scheme == "http",
      ["localhost", "127.0.0.1"].contains(callback.host ?? ""), callback.path == "/callback",
      let port = callback.port, let localPort = UInt16(exactly: port), localPort > 0,
      let state = oauth?.queryItems?.first(where: { $0.name == "state" })?.value, !state.isEmpty,
      browserUrl.host == endpoint.host, browserUrl.port == endpoint.port,
      ["https", "http"].contains(browserUrl.scheme ?? ""), browserUrl.scheme == endpoint.scheme,
      browserUrl.user == nil, browserUrl.password == nil, endpoint.user == nil, endpoint.password == nil else {
      throw NSError(domain: "ClaudePhoneAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: "Claude returned an invalid sign-in URL. Try again."])
    }
    self.parent = parent
    browser = SFSafariViewController(url: browserUrl)
    self.completion = completion
    super.init()
    browser.delegate = self
    relay = try ClaudeCallbackRelay(port: localPort, state: state, endpoint: endpoint) { [weak self] result in
      self?.finish(result.map { true })
    }
  }

  func start() {
    relay.start { [weak self] in
      guard let self, !self.completed else { return }
      self.parent.present(self.browser, animated: true)
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 10 * 60) { [weak self] in
      guard let self, !self.completed else { return }
      self.finish(.failure(NSError(domain: "ClaudePhoneAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: "Claude sign-in expired. Try again."])))
    }
  }

  func cancel() { finish(.success(false)) }
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) { cancel() }
  private func finish(_ result: Result<Bool, Error>) {
    guard !completed else { return }
    completed = true
    relay.stop()
    if browser.presentingViewController != nil {
      browser.dismiss(animated: true) { self.completion(result) }
    } else { completion(result) }
  }
}
