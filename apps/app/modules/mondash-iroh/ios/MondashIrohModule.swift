import ExpoModulesCore
import Foundation
import Security

private let protocolName = Data("mondash-experiment/http/1".utf8)
private func transportError(_ message: String) -> NSError { NSError(domain: message, code: 1) }

public class MondashIrohModule: Module {
  private let requests = Requests()
  private let service = "app.mondash.iroh.identity"
  public func definition() -> ModuleDefinition {
    Name("MondashIroh")
    OnAppEntersBackground { Task { await self.requests.pause() } }
    OnAppEntersForeground { Task { await self.requests.resume() } }
    OnAppContextDestroys { Task { await self.requests.pause() } }
    AsyncFunction("pair") { (id: String, ticket: String, token: String) async throws -> String in
      let request = try await self.requests.create(id)
      let deadline = Task { do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }; try? await self.requests.cancel(id) }
      defer { deadline.cancel() }
      do {
        let peer = try await request.pair(ticket: ticket, key: self.loadKey(), token: token)
        try await self.requests.cancel(id)
        return peer
      } catch { try? await self.requests.cancel(id); throw error }
    }
    AsyncFunction("open") { (id: String, ticket: String, bytes: Data) async throws in
      let request = try await self.requests.create(id)
      do { try await request.open(ticket: ticket, key: self.loadKey(), bytes: bytes) }
      catch { try? await self.requests.cancel(id); throw error }
    }
    AsyncFunction("read") { (id: String, limit: Int) async throws -> Data in
      try await self.requests.get(id).read(limit: limit)
    }
    AsyncFunction("cancel") { (id: String) async throws in
      try await self.requests.cancel(id)
    }
    AsyncFunction("cancelAll") { () async in await self.requests.cancelAll() }
    AsyncFunction("recordDiagnostics") { (json: String) throws in
      let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
      try Data(json.utf8).write(to: directory.appendingPathComponent("mondash-iroh-diagnostics.json"), options: .atomic)
    }
  }

  private func loadKey() throws -> Data {
    func read(_ service: String, account: String) throws -> Data? {
      let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
        kSecAttrAccount as String: account, kSecReturnData as String: true]
      var result: CFTypeRef?
      let status = SecItemCopyMatching(query as CFDictionary, &result)
      if status == errSecItemNotFound { return nil }
      guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
      guard let key = result as? Data, key.count == 32 else { throw transportError("Stored Iroh identity is invalid") }
      return key
    }
    if let key = try read(service, account: "identity") { return key }
    // Preserve the explicitly installed trial's identity when replacing its test screen with Mondash.
    let key = try read("app.mondash.iroh.probe.isolated-key", account: "scratch-identity") ?? SecretKey.generate().toBytes()
    let item: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
      kSecAttrAccount as String: "identity", kSecValueData as String: key,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
    let status = SecItemAdd(item as CFDictionary, nil)
    if status == errSecDuplicateItem, let existing = try read(service, account: "identity") { return existing }
    guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    return key
  }
}

private actor Requests {
  var active: [String: NativeRequest] = [:]
  var cancelled: [String] = []
  var paused = false
  func pause() async { paused = true; await cancelAll() }
  func resume() { paused = false }
  func create(_ id: String) throws -> NativeRequest {
    guard !paused, active[id] == nil, !cancelled.contains(id), active.count < 24 else { throw transportError("Request unavailable or cancelled") }
    let request = NativeRequest(); active[id] = request; return request
  }
  func get(_ id: String) throws -> NativeRequest {
    guard let request = active[id] else { throw transportError("Request closed") }; return request
  }
  func cancel(_ id: String) async throws {
    cancelled.append(id); if cancelled.count > 256 { cancelled.removeFirst() }
    let request = active.removeValue(forKey: id)
    try await request?.close()
  }
  func cancelAll() async {
    let ids = Array(active.keys)
    await withTaskGroup(of: Void.self) { group in
      for id in ids { group.addTask { try? await self.cancel(id) } }
    }
  }
}

private actor NativeRequest {
  var endpoint: Endpoint?; var connection: Connection?; var recv: RecvStream?
  var reading = false; var closed = false
  private func connect(ticket: String, key: Data) async throws -> EndpointAddr {
    guard !closed else { throw transportError("Request cancelled") }
    let addr = try EndpointTicket.fromString(str: ticket).endpointAddr()
    let endpoint = try await Endpoint.bind(options: EndpointOptions(preset: presetN0(), secretKey: key))
    if closed { try await endpoint.close(); throw transportError("Request cancelled") }
    self.endpoint = endpoint
    let connection = try await dial(endpoint, addr)
    if closed { try connection.close(errorCode: 0, reason: Data()); throw transportError("Request cancelled") }
    self.connection = connection
    return addr
  }
  private func send(_ frame: [String: Any]) async throws -> RecvStream {
    guard !closed, let connection else { throw transportError("Request cancelled") }
    let stream = try await connection.openBi()
    try await stream.send().writeAll(buf: JSONSerialization.data(withJSONObject: frame))
    try await stream.send().finish()
    guard !closed else { throw transportError("Request cancelled") }
    return stream.recv()
  }
  func pair(ticket: String, key: Data, token: String) async throws -> String {
    let addr = try await connect(ticket: ticket, key: key)
    let pair = try await send(["version": 1, "op": "pair", "token": token])
    let result = String(decoding: try await pair.readToEnd(sizeLimit: 1024), as: UTF8.self)
    let bytes = Data("GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n".utf8)
    let health = try await send(["version": 1, "op": "http-bytes", "body": bytes.base64EncodedString()])
    let response = try await health.readToEnd(sizeLimit: 65536)
    guard !closed, response.starts(with: Data("HTTP/1.1 200".utf8)) else { throw transportError("Mac pairing refused: \(result)") }
    return addr.id().description
  }
  func open(ticket: String, key: Data, bytes: Data) async throws {
    guard bytes.count <= 3_500_000 else { throw transportError("Request too large") }
    _ = try await connect(ticket: ticket, key: key)
    recv = try await send(["version": 1, "op": "http-bytes", "body": bytes.base64EncodedString()])
  }
  func read(limit: Int) async throws -> Data {
    guard !closed, !reading, let recv, limit > 0, limit <= 65536 else { throw transportError("Only one bounded read is allowed per request") }
    reading = true; defer { reading = false }
    return try await recv.read(sizeLimit: UInt32(limit))
  }
  func close() async throws {
    closed = true
    let previous = endpoint
    try? connection?.close(errorCode: 0, reason: Data("Mondash request closed".utf8))
    endpoint = nil; connection = nil; recv = nil
    if let previous { try await previous.close() }
  }
}

private func dial(_ endpoint: Endpoint, _ addr: EndpointAddr) async throws -> Connection {
  let watchdog = Task { do { try await Task.sleep(nanoseconds: 15_000_000_000) } catch { return }; try? await endpoint.close() }
  defer { watchdog.cancel() }
  return try await endpoint.connect(addr: addr, alpn: protocolName)
}
