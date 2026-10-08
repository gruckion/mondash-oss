import Foundation
import Network

/// Receives the browser's loopback OAuth callback and forwards it to the Mac over Tailscale.
final class ClaudeCallbackRelay {
  private let listener: NWListener
  private let state: String
  private let endpoint: URL
  private let completion: (Result<Void, Error>) -> Void
  private var connections: [NWConnection] = []
  private var pendingHeaders: Set<ObjectIdentifier> = []
  private var task: URLSessionDataTask?
  private var submitted = false
  private var stopped = false

  init(port: UInt16, state: String, endpoint: URL, completion: @escaping (Result<Void, Error>) -> Void) throws {
    self.state = state
    self.endpoint = endpoint
    self.completion = completion
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!)
    listener = try NWListener(using: parameters)
  }

  func start(ready: @escaping () -> Void) {
    listener.stateUpdateHandler = { [weak self] status in
      guard let self, !self.stopped else { return }
      switch status {
      case .ready: ready()
      case .failed: self.finish(.failure(self.error("Could not receive Claude's sign-in callback. Try again.")))
      default: break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self, !self.stopped, !self.submitted, self.connections.count < 8 else { connection.cancel(); return }
      self.connections.append(connection)
      self.pendingHeaders.insert(ObjectIdentifier(connection))
      connection.start(queue: .main)
      self.receive(connection, data: Data())
      DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
        guard let self, self.pendingHeaders.remove(ObjectIdentifier(connection)) != nil else { return }
        connection.cancel()
        self.connections.removeAll { $0 === connection }
      }
    }
    listener.start(queue: .main)
  }

  func stop() {
    stopped = true
    listener.cancel()
    task?.cancel()
    connections.forEach { $0.cancel() }
    connections.removeAll()
    pendingHeaders.removeAll()
  }

  private func receive(_ connection: NWConnection, data: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] chunk, _, ended, error in
      guard let self, !self.stopped else { return }
      var data = data
      if let chunk { data.append(chunk) }
      guard data.count <= 16384, error == nil else { connection.cancel(); return }
      if let header = String(data: data, encoding: .utf8), header.contains("\r\n\r\n") {
        self.pendingHeaders.remove(ObjectIdentifier(connection))
        self.handle(header, connection: connection)
      } else if !ended { self.receive(connection, data: data) }
      else { connection.cancel() }
    }
  }

  private func handle(_ header: String, connection: NWConnection) {
    let line = header.components(separatedBy: "\r\n").first?.split(separator: " ") ?? []
    guard line.count == 3, line[0] == "GET", line[1].hasPrefix("/callback?"),
      let url = URLComponents(string: "http://localhost" + line[1]), url.path == "/callback",
      let items = url.queryItems, items.filter({ $0.name == "state" }).count == 1,
      items.first(where: { $0.name == "state" })?.value == state,
      items.filter({ $0.name == "code" }).count == 1,
      let code = items.first(where: { $0.name == "code" })?.value,
      !code.isEmpty, code.utf8.count <= 4096, code.rangeOfCharacter(from: .whitespacesAndNewlines) == nil,
      !submitted else { respond(connection, status: 400, body: "Invalid callback"); return }
    submitted = true
    listener.cancel()
    var request = URLRequest(url: endpoint, timeoutInterval: 50)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["code": code, "state": state])
    task = URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
      DispatchQueue.main.async {
        guard let self, !self.stopped else { return }
        let payload = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        guard error == nil, let http = response as? HTTPURLResponse, http.statusCode == 200,
          payload?["state"] as? String == "connected" else {
          self.respond(connection, status: 502, body: "Sign-in failed") {
            self.finish(.failure(self.error("Claude could not complete sign-in. Try again.")))
          }
          return
        }
        self.respond(connection, status: 200, body: "Signed in") { self.finish(.success(())) }
      }
    }
    task?.resume()
  }

  private func respond(_ connection: NWConnection, status: Int, body: String, completion: (() -> Void)? = nil) {
    let response = "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")\r\nContent-Type: text/plain\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: \(body.utf8.count)\r\n\r\n\(body)"
    connection.send(content: response.data(using: .utf8), completion: .contentProcessed { [weak self] _ in
      connection.cancel()
      self?.connections.removeAll { $0 === connection }
      completion?()
    })
  }

  private func finish(_ result: Result<Void, Error>) { completion(result) }
  private func error(_ message: String) -> NSError { NSError(domain: "ClaudePhoneAuth", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
}
