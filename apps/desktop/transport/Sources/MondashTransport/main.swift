import Foundation
import Security
import Darwin
import IrohLib

let alpn = Data("mondash-experiment/http/1".utf8)
struct ProbeError: Error { let message: String }
func check(_ value: Bool, _ message: String) throws { if !value { throw ProbeError(message: message) } }
func report(_ name: String, _ details: [String: Any] = [:]) {
  var result = details; result["check"] = name; result["pass"] = true
  let data = try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
  print(String(decoding: data, as: UTF8.self)); fflush(stdout)
}
func randomToken() -> String {
  var data = Data(count: 32)
  let result = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }
  precondition(result == errSecSuccess)
  return data.base64EncodedString()
}
struct Request: Codable { var op: String; var version: Int? = 1; var token: String?; var body: Data?; var path: String? }
actor Permissions {
  let path: String?
  var allowed = Set<String>()
  var connections: [UUID: Connection] = [:]
  func register(_ connection: Connection) -> UUID { let id = UUID(); connections[id] = connection; return id }
  func unregister(_ id: UUID) { connections.removeValue(forKey: id) }
  init(path: String? = nil) throws {
    self.path = path
    if let path, FileManager.default.fileExists(atPath: path) { allowed = try JSONDecoder().decode(Set<String>.self, from: Data(contentsOf: URL(fileURLWithPath: path))) }
  }
  func persist(_ peers: Set<String>) throws {
    guard let path else { return }
    try JSONEncoder().encode(peers).write(to: URL(fileURLWithPath: path), options: .atomic)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
  }
  var token = randomToken(); var expires = Date().addingTimeInterval(60)
  var approved = false; var spent = false
  func issue(expired: Bool = false, approve: Bool = true, lifetime: Double = 60) -> String {
    token = randomToken(); expires = Date().addingTimeInterval(expired ? -1 : lifetime); approved = approve; spent = false; return token
  }
  func revoke(_ id: String) throws {
    var next = allowed; next.remove(id); try persist(next); allowed = next
    for connection in connections.values where connection.remoteId().description == id {
      try? connection.close(errorCode: 44, reason: Data("Device removed".utf8))
    }
  }
  func authorize(id: String, request: Request) throws -> String? {
    if request.version != 1 { return "protocol-version-mismatch" }
    if request.op == "pair" {
      if request.token != token { return "invalid-token" }
      if spent { return "replayed-token" }
      if expires <= Date() { return "expired-token" }
      if !approved { return "approval-required" }
      var next = allowed; next.insert(id); try persist(next); allowed = next; spent = true; return "paired"
    }
    return allowed.contains(id) ? nil : "unpaired-or-revoked"
  }
}
func socketRead(_ fd: Int32, size: Int = 65536) async throws -> Data {
  try await withCheckedThrowingContinuation { continuation in
    DispatchQueue.global(qos: .utility).async {
      var bytes = [UInt8](repeating: 0, count: size)
      let n = Darwin.read(fd, &bytes, size)
      if n >= 0 { continuation.resume(returning: Data(bytes.prefix(n))) }
      else { continuation.resume(throwing: ProbeError(message: "socket read failed or timed out")) }
    }
  }
}
// A closed Iroh connection must interrupt even a quiet local action response, without shutting
// down a recycled descriptor after the request has finished.
final class ForwardSocket: @unchecked Sendable {
  let fd: Int32
  private let lock = NSLock()
  private var open = true
  init(_ fd: Int32) { self.fd = fd }
  func interrupt() { lock.lock(); defer { lock.unlock() }; if open { Darwin.shutdown(fd, SHUT_RDWR) } }
  func close() { lock.lock(); defer { lock.unlock() }; if open { open = false; Darwin.close(fd) } }
}
func forwardHTTP(_ input: Data, to backend: String, send: SendStream, connection: Connection) async throws {
  var raw = input
  if let end = raw.range(of: Data("\r\n\r\n".utf8)) {
    let header = String(decoding: raw.prefix(upTo: end.lowerBound), as: UTF8.self)
    let lines = header.components(separatedBy: "\r\n").filter { !$0.lowercased().hasPrefix("connection:") }
    raw = Data((lines.joined(separator: "\r\n") + "\r\nConnection: close").utf8) + raw.suffix(from: end.lowerBound)
  }
  if let secretFile = ProcessInfo.processInfo.environment["PROBE_CAPABILITY_FILE"] {
    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: secretFile))) as! [String: Any]
    guard let capability = object["capability"] as? String, let end = raw.range(of: Data("\r\n\r\n".utf8)),
          !String(decoding: raw.prefix(upTo: end.lowerBound), as: UTF8.self).lowercased().contains("x-mondash-capability") else { throw ProbeError(message: "invalid capability request") }
    raw.insert(contentsOf: Data("\r\nx-mondash-capability: \(capability)".utf8), at: end.lowerBound)
  }
  guard let url = URL(string: backend), let port = url.port, url.host == "127.0.0.1",
        ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(where: { raw.starts(with: Data("\($0) /api/".utf8)) }) else { throw ProbeError(message: "invalid gateway request") }
  try await Task.detached {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { throw ProbeError(message: "socket failed") }
    let owned = ForwardSocket(fd)
    let watcher = Task { _ = await connection.closed(); owned.interrupt() }
    defer { owned.close(); watcher.cancel() }
    var timeout = timeval(tv_sec: 180, tv_usec: 0)
    _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigPipe: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_port = UInt16(port).bigEndian; inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
    let rc = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard rc == 0 else { throw ProbeError(message: "backend connect failed") }
    var sent = 0
    try raw.withUnsafeBytes { bytes in
      while sent < bytes.count {
        let n = Darwin.write(fd, bytes.baseAddress!.advanced(by: sent), bytes.count - sent)
        guard n > 0 else { throw ProbeError(message: "backend write failed") }; sent += n
      }
    }
    while true {
      let bytes = try await socketRead(fd)
      if bytes.isEmpty { break }
      try await send.writeAll(buf: bytes)
    }
  }.value
}
func gateway(_ connection: Connection, _ permissions: Permissions, _ backend: String) async {
  let registration = await permissions.register(connection)
  while let bi = try? await connection.acceptBi() {
    Task {
      do {
        let bytes = try await bi.recv().readToEnd(sizeLimit: 5_000_000)
        let request = try JSONDecoder().decode(Request.self, from: bytes)
        if let status = try await permissions.authorize(id: connection.remoteId().description, request: request) {
          try await bi.send().writeAll(buf: Data(status.utf8))
        } else if request.op == "revoke-self" {
          try await permissions.revoke(connection.remoteId().description)
          try await bi.send().writeAll(buf: Data("revoked".utf8))
        } else if request.op == "http-bytes", let body = request.body {
          try await forwardHTTP(body, to: backend, send: bi.send(), connection: connection)
        } else {
          try await bi.send().writeAll(buf: Data("unsupported".utf8))
        }
        try await bi.send().finish()
      } catch { try? await bi.send().reset(errorCode: 43) }
    }
  }
  await permissions.unregister(registration)
}

func run() async throws {
  let env = ProcessInfo.processInfo.environment
  guard let backend = env["PROBE_BACKEND"], let identityFile = env["PROBE_IDENTITY_FILE"], let pairingsFile = env["PROBE_PAIRINGS_FILE"], let listenerFile = env["PROBE_LISTENER_FILE"] else { throw ProbeError(message: "Mac transport configuration missing") }
  let identity = URL(fileURLWithPath: identityFile)
  let secret: Data
  if FileManager.default.fileExists(atPath: identity.path) { secret = try Data(contentsOf: identity) }
  else { secret = SecretKey.generate().toBytes(); try secret.write(to: identity, options: .atomic); try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: identity.path) }
  let server = try await Endpoint.bind(options: EndpointOptions(preset: presetN0(), secretKey: secret, alpns: [alpn]))
  let permissions = try Permissions(path: pairingsFile)
  let acceptTask = Task {
    while let incoming = await server.acceptNext() {
      Task { if let connection = try? await incoming.accept().connect() { await gateway(connection, permissions, backend) } }
    }
  }
  await server.online()
  func invitation(nonce: String? = nil) async throws -> Data {
    let token = await permissions.issue(lifetime: 120)
    var value = ["ticket": try EndpointTicket.fromAddr(addr: server.addr()).description, "token": token, "id": server.id().description]
    if let nonce { value["nonce"] = nonce }
    return try JSONSerialization.data(withJSONObject: value)
  }
  try await invitation().write(to: URL(fileURLWithPath: listenerFile), options: .atomic)
  report("listener-ready")
  let data = identity.deletingLastPathComponent()
  var seen: String?
  while !Task.isCancelled {
    if let owner = env["PROBE_PARENT_PID"].flatMap(Int32.init), getppid() != owner { break }
    let command = data.appendingPathComponent("pairing-command.json")
    if let bytes = try? Data(contentsOf: command), let value = try? JSONDecoder().decode([String: String].self, from: bytes), let nonce = value["nonce"], nonce != seen {
      seen = nonce
      if value["action"] == "invite" {
        try await invitation(nonce: nonce).write(to: data.appendingPathComponent("pairing-response.json"), options: .atomic)
      } else if value["action"] == "revoke", let peer = value["id"] {
        try await permissions.revoke(peer)
        try JSONSerialization.data(withJSONObject: ["nonce": nonce, "revoked": true]).write(to: data.appendingPathComponent("pairing-response.json"), options: .atomic)
      }
    }
    try await Task.sleep(nanoseconds: 100_000_000)
  }
  try await server.close(); acceptTask.cancel()
}
umask(0o077)
do { try await run() } catch { fputs("Mondash connection failed: \(error)\n", stderr); exit(1) }
