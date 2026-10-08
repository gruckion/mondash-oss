import Foundation

let port = UInt16(CommandLine.arguments[1])!
let endpoint = URL(string: CommandLine.arguments[2])!
let state = "expected-state"
var connected = false
var requestsFinished = false
var failed = false

func request(_ query: String) -> Int {
  let semaphore = DispatchSemaphore(value: 0)
  var status = 0
  URLSession.shared.dataTask(with: URL(string: "http://localhost:\(port)/callback?\(query)")!) { _, response, error in
    status = (response as? HTTPURLResponse)?.statusCode ?? 0
    semaphore.signal()
  }.resume()
  precondition(semaphore.wait(timeout: .now() + 20) == .success, "callback request timed out")
  return status
}

let relay = try ClaudeCallbackRelay(port: port, state: state, endpoint: endpoint) { result in
  switch result {
  case .success: connected = true
  case .failure: failed = true
  }
}
relay.start {
  DispatchQueue.global().async {
    precondition(request("code=accepted&state=wrong-state") == 400)
    precondition(request("code=accepted&state=\(state)&state=\(state)") == 400)
    precondition(request("code=line%0Abreak&state=\(state)") == 400)
    precondition(request("code=accepted&state=\(state)") == 200)
    DispatchQueue.main.async { requestsFinished = true }
  }
}
let deadline = Date().addingTimeInterval(25)
while (!connected || !requestsFinished) && !failed && Date() < deadline {
  RunLoop.main.run(until: Date().addingTimeInterval(0.02))
}
relay.stop()
precondition(connected && requestsFinished && !failed, "native relay did not complete")
print("Native loopback callback relayed and verified")
