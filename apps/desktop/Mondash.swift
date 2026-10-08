// The Mac app owns its local backend, encrypted endpoint and browser gateway.
import AppKit
import Darwin
import Foundation
import ServiceManagement
import WebKit

final class MondashApp: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var status: NSStatusItem!
    var child: Process?
    var browser: Process?
    var transport: Process?
    var transportRestarts = 0
    var browserRestarts = 0
    var quitting = false
    var restarting = 0
    var lock: Int32 = -1
    var timer: Timer?
    var seen: String?
    var loaded = false
    var browserRequested: String?
    let env = ProcessInfo.processInfo.environment
    var dashboardTrial: Bool { Bundle.main.bundleIdentifier == "com.mondash.iroh.trial.mac" }
    lazy var data = env["MONDASH_PROBE_DATA"].map { URL(fileURLWithPath: $0) } ??
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Mondash Iroh")
    lazy var port = env["MONDASH_PROBE_PORT"] ?? availablePort()
    lazy var cap = env["MONDASH_PROBE_CAPABILITY"] ?? (UUID().uuidString + UUID().uuidString).replacingOccurrences(of: "-", with: "").lowercased()
    lazy var base = URL(string: "http://127.0.0.1:\(port)")!

    func record(_ event: String, _ extra: [String: Any] = [:]) {
        let item: [String: Any] = ["event": event, "pid": getpid(), "child": child?.processIdentifier ?? 0,
            "childRunning": child?.isRunning ?? false, "windowVisible": window?.isVisible ?? false,
            "activation": NSApp.activationPolicy().rawValue, "loaded": loaded, "restarts": restarting,
            "irohChild": transport?.processIdentifier ?? 0, "irohRunning": transport?.isRunning ?? false,
            "irohRestarts": transportRestarts, "browserRunning": browser?.isRunning ?? false,
            "at": Date().timeIntervalSince1970].merging(extra) { _, new in new }
        let bytes = try! JSONSerialization.data(withJSONObject: item, options: [.sortedKeys])
        let log = data.appendingPathComponent("events.jsonl")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        let file = try! FileHandle(forWritingTo: log); try! file.seekToEnd(); try! file.write(contentsOf: bytes + Data([10])); try! file.close()
        try! bytes.write(to: data.appendingPathComponent("state.json"), options: [.atomic])
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        try! FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        lock = Darwin.open(data.appendingPathComponent("instance.lock").path, O_CREAT | O_RDWR, 0o600)
        guard lock >= 0, flock(lock, LOCK_EX | LOCK_NB) == 0 else { print("duplicate-instance-rejected"); exit(78) }
        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let icon = NSImage(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("mondash-icon.png")) {
            icon.size = NSSize(width: 18, height: 18); status.button?.image = icon
        }
        status.button?.toolTip = "Mondash"
        let menu = NSMenu(); menu.addItem(withTitle: "Open Mondash", action: #selector(reopen), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Open in browser", action: #selector(openBrowser), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Connect a browser…", action: #selector(pairBrowser), keyEquivalent: "").target = self
        menu.addItem(withTitle: "Paired devices…", action: #selector(manageDevices), keyEquivalent: "").target = self
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "Quit Mondash", action: #selector(quit), keyEquivalent: "q").target = self
        status.menu = menu
        let mainMenu = NSMenu(); let appItem = NSMenuItem(); appItem.submenu = menu.copy() as? NSMenu; mainMenu.addItem(appItem)
        let editMenu = NSMenu(title: "Edit")
        for (title, action, key) in [("Undo", "undo:", "z"), ("Cut", "cut:", "x"), ("Copy", "copy:", "c"), ("Paste", "paste:", "v"), ("Select All", "selectAll:", "a")] {
            if title == "Cut" || title == "Select All" { editMenu.addItem(NSMenuItem.separator()) }
            editMenu.addItem(withTitle: title, action: Selector(action), keyEquivalent: key)
        }
        let editItem = NSMenuItem(); editItem.submenu = editMenu; mainMenu.addItem(editItem)
        NSApp.mainMenu = mainMenu
        window = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 1080, height: 680), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Mondash"; window.delegate = self; window.isReleasedWhenClosed = false
        let config = WKWebViewConfiguration(); config.websiteDataStore = .nonPersistent()
        config.userContentController.add(self, name: "mondash")
        web = WKWebView(frame: window.contentView!.bounds, configuration: config); web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self; web.uiDelegate = self; window.contentView!.addSubview(web)
        startChild()
        startBrowser()
        if env["MONDASH_PROBE_IROH"] == "1" || dashboardTrial { startTransport() }
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in self?.poll() }
        record("launched", ["menuBar": status.button != nil, "loginStatus": SMAppService.mainApp.status.rawValue])
        if env["MONDASH_PROBE_HIDDEN"] != "1" { reopen() }
    }

    func startTransport() {
        guard !quitting else { return }
        let metadata = data.appendingPathComponent("gateway-private.json")
        try! JSONSerialization.data(withJSONObject: ["port": Int(port)!, "capability": cap]).write(to: metadata, options: .atomic)
        try! FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: metadata.path)
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/iroh-transport")
        process.arguments = ["--listen"]
        process.currentDirectoryURL = data
        process.environment = ["HOME": env["HOME"] ?? NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "PROBE_BACKEND": "http://127.0.0.1:\(port)", "PROBE_CAPABILITY_FILE": metadata.path, "PROBE_PARENT_PID": String(getpid()),
            "PROBE_LISTEN_SECONDS": (env["MONDASH_PROBE_IROH_PERSISTENT"] == "1" || dashboardTrial) ? "0" : "1800",
            "PROBE_LISTENER_FILE": data.appendingPathComponent("listener-private.json").path,
            "PROBE_IDENTITY_FILE": data.appendingPathComponent("iroh-identity.key").path,
            "PROBE_PAIRINGS_FILE": data.appendingPathComponent("iroh-pairings.json").path]
        let log = data.appendingPathComponent("transport.log")
        FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        let file = try! FileHandle(forWritingTo: log); process.standardOutput = file; process.standardError = file
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self, !self.quitting else { return }
                self.record("iroh-exited", ["exit": ended.terminationStatus])
                guard self.transportRestarts < 2 else { self.record("iroh-restart-limit"); return }
                self.transportRestarts += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.startTransport() }
            }
        }
        transport = process
        do { try process.run(); record("iroh-started") } catch { record("iroh-start-failed", ["error": error.localizedDescription]) }
    }

    func startBrowser() {
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/mondash-browser")
        process.currentDirectoryURL = data
        process.environment = ["HOME": NSHomeDirectory(), "TMPDIR": NSTemporaryDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "MONDASH_BACKEND": base.absoluteString, "MONDASH_LOCAL_CAPABILITY": cap, "MONDASH_DATA": data.path, "MONDASH_PARENT_PID": String(getpid()), "MONDASH_WEB_ROOT": Bundle.main.resourceURL!.appendingPathComponent("web").path]
        let log = data.appendingPathComponent("browser.log")
        FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
        process.standardOutput = try! FileHandle(forWritingTo: log); process.standardError = process.standardOutput
        process.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self, !self.quitting, self.browserRestarts < 2 else { return }
                self.browserRestarts += 1
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.startBrowser() }
            }
        }
        browser = process
        do { try process.run() } catch { record("browser-start-failed", ["error": error.localizedDescription]) }
    }
    func browserRequest(path: String, body: [String: String] = [:], use: @escaping ([String: Any]) -> Void) {
        guard let bytes = try? Data(contentsOf: data.appendingPathComponent("browser-gateway.json")), let state = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any], let origin = state["localOrigin"] as? String, let url = URL(string: origin + path) else { return }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        request.setValue(origin, forHTTPHeaderField: "Origin"); request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.setValue(cap, forHTTPHeaderField: "x-mondash-capability")
        URLSession.shared.dataTask(with: request) { bytes, response, error in
            guard (response as? HTTPURLResponse)?.statusCode == 200, let bytes, let reply = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any] else {
                DispatchQueue.main.async { let alert = NSAlert(); alert.messageText = "Mondash is starting"; alert.informativeText = "Try again shortly. For another device, connect your Mac to Wi-Fi."; alert.runModal() }; return
            }
            DispatchQueue.main.async { use(reply) }
        }.resume()
    }
    func browserLink(path: String, use: @escaping (URL) -> Void) {
        browserRequest(path: path) { reply in
            guard let value = reply["url"] as? String, let url = URL(string: value) else { return }
            use(url)
        }
    }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, message.frameInfo.securityOrigin.host == "127.0.0.1", message.frameInfo.securityOrigin.port == Int(port), let command = message.body as? String else { return }
        switch command {
        case "open-browser": openBrowser()
        case "open-settings-browser", "connect-slack", "connect-notion", "connect-claude":
            browserLink(path: "/_handoff/mint") { url in
                guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return }
                components.queryItems = [URLQueryItem(name: "next", value: command == "open-settings-browser" ? "settings" : command)]
                if let destination = components.url { self.showBrowser(destination) }
            }
        case "manage-devices": manageDevices()
        default: break
        }
    }
    @objc func manageDevices() {
        browserRequest(path: "/_pairing/list") { reply in
            let peers = reply["peers"] as? [String] ?? []
            let browsers = reply["browsers"] as? [[String: String]] ?? []
            let alert = NSAlert(); alert.messageText = "Paired devices"
            if peers.isEmpty { alert.informativeText = "No phones or browsers are paired with this Mac."; alert.addButton(withTitle: "OK"); alert.runModal(); return }
            alert.informativeText = "Remove a device to immediately disconnect it. To reconnect it, create a new invitation."
            let selection = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 440, height: 30))
            selection.addItems(withTitles: peers.map { id in browsers.first { $0["id"] == id }?["name"] ?? (String(id.prefix(12)) + "…" + String(id.suffix(8))) })
            alert.accessoryView = selection; alert.addButton(withTitle: "Remove device"); alert.addButton(withTitle: "Cancel")
            if alert.runModal() == .alertFirstButtonReturn {
                self.browserRequest(path: "/_pairing/revoke", body: ["id": peers[selection.indexOfSelectedItem]]) { _ in }
            }
        }
    }
    func showBrowser(_ url: URL) {
        let opened = NSWorkspace.shared.open(url)
        record("browser-opened", ["defaultBrowserAccepted": opened])
        if !opened, let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
            NSWorkspace.shared.open([url], withApplicationAt: safari, configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        }
    }
    @objc func openBrowser() { browserLink(path: "/_handoff/mint") { self.showBrowser($0) } }
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls where url.scheme == "mondash" && url.host == "browser" && url.path.isEmpty && url.fragment == nil {
            if window != nil { reopen() }
            guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems,
                  items.count == 1, items[0].name == "request", let id = items[0].value,
                  id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { continue }
            if loaded { browserRequest(path: "/_browser/approve", body: ["id": id]) { _ in } }
            else { browserRequested = id }
        }
    }
    @objc func pairBrowser() {
        browserLink(path: "/_pairing/mint") { url in
            let alert = NSAlert(); alert.messageText = "Connect a browser to Mondash"
            alert.informativeText = "Open this link on your home Wi-Fi within two minutes. It pairs one browser with this Mac. Keep the link private."
            let field = NSTextField(string: url.absoluteString); field.isEditable = false; field.isSelectable = true; field.frame = NSRect(x: 0, y: 0, width: 440, height: 64); alert.accessoryView = field
            alert.addButton(withTitle: "Copy link"); alert.addButton(withTitle: "Open here"); alert.addButton(withTitle: "Cancel")
            let result = alert.runModal()
            if result == .alertFirstButtonReturn { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(url.absoluteString, forType: .string) }
            if result == .alertSecondButtonReturn { self.showBrowser(url) }
        }
    }

    func startChild() {
        guard !quitting else { return }
        let process = Process()
        process.executableURL = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/mondash-server")
        process.currentDirectoryURL = data
        let credentials = data.appendingPathComponent("server-env.json")
        var environment = (try? JSONDecoder().decode([String: String].self, from: Data(contentsOf: credentials))) ?? [:]
        environment.merge(["HOME": env["HOME"] ?? NSHomeDirectory(), "USER": env["USER"] ?? "", "TMPDIR": NSTemporaryDirectory(),
            "PATH": Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers").path + ":/usr/bin:/bin:/usr/sbin:/sbin", "MONDASH_HOST": "127.0.0.1", "MONDASH_PORT": port,
            "MONDASH_READ_ONLY": (env["MONDASH_PROBE_LIVE"] == "1" || dashboardTrial) ? "0" : "1", "MONDASH_WEB_ROOT": Bundle.main.resourceURL!.appendingPathComponent("web").path,
            "MONDASH_LOCAL_CAPABILITY": cap, "MONDASH_PARENT_PID": String(getpid()),
            "MONDASH_PROFILE": data.appendingPathComponent("mondash.local.json").path]) { _, new in new }
        process.environment = environment
        let path = data.appendingPathComponent("backend.log").path
        FileManager.default.createFile(atPath: path, contents: nil, attributes: [.posixPermissions: 0o600])
        let file = FileHandle(forWritingAtPath: path)!; process.standardOutput = file; process.standardError = file
        process.terminationHandler = { [weak self] ended in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                if ended.terminationStatus == 75 {
                    self.record("settings-restart")
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.startChild() }
                    return
                }
                self.record("helper-exited", ["exit": ended.terminationStatus])
                if self.restarting >= 2 { self.record("restart-limit"); return }
                self.restarting += 1; self.loaded = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { self.startChild() }
            }
        }
        child = process
        do { try process.run(); record("helper-started") } catch { record("helper-start-failed", ["error": error.localizedDescription]) }
    }

    @objc func reopen() {
        NSApp.setActivationPolicy(.regular)
        if window.isMiniaturized { window.deminiaturize(nil) }
        NSApp.unhide(nil)
        NSApp.activate()
        window.makeKeyAndOrderFront(nil)
        record("opened", ["active": NSApp.isActive, "windowKey": window.isKeyWindow])
    }
    func windowWillClose(_ note: Notification) { NSApp.setActivationPolicy(.accessory); DispatchQueue.main.async { self.record("closed") } }
    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows visible: Bool) -> Bool { reopen(); return false }
    @objc func quit() { NSApp.terminate(nil) }
    func applicationWillTerminate(_ note: Notification) {
        quitting = true; timer?.invalidate()
        for process in [browser, transport, child].compactMap({ $0 }) where process.isRunning {
            process.terminate()
            let until = Date().addingTimeInterval(3)
            while process.isRunning && Date() < until { Thread.sleep(forTimeInterval: 0.05) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        record("quit")
        if lock >= 0 { flock(lock, LOCK_UN); Darwin.close(lock) }
    }

    func poll() {
        if !loaded && child?.isRunning == true {
            var request = URLRequest(url: base.appendingPathComponent("api/health")); request.setValue(cap, forHTTPHeaderField: "x-mondash-capability")
            URLSession.shared.dataTask(with: request) { bytes, response, error in
                guard (response as? HTTPURLResponse)?.statusCode == 200 else { return }
                DispatchQueue.main.async {
                    guard !self.loaded else { return }; self.loaded = true
                    var page = URLRequest(url: self.base.appendingPathComponent("issues")); page.setValue(self.cap, forHTTPHeaderField: "x-mondash-capability")
                    self.web.load(page); self.record("backend-ready")
                    if let id = self.browserRequested { self.browserRequested = nil; self.browserRequest(path: "/_browser/approve", body: ["id": id]) { _ in } }
                }
            }.resume()
        }
    }

    func dashboardURL(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }
    // Web-only destinations (including GitHub replies) must leave the embedded dashboard.
    func webView(_ view: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url, ["https", "http"].contains(url.scheme ?? "") else { return nil }
        if dashboardURL(url) { view.load(action.request) }
        else { showBrowser(url) }
        return nil
    }
    func webView(_ view: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        // New-window links go through the UI delegate; subframes stay in their web view.
        guard action.targetFrame?.isMainFrame == true, let url = action.request.url,
              ["https", "http"].contains(url.scheme ?? ""), !dashboardURL(url) else {
            decisionHandler(.allow); return
        }
        showBrowser(url)
        decisionHandler(.cancel)
    }
    func webView(_ view: WKWebView, didFinish navigation: WKNavigation!) { record("web-loaded") }
    func webView(_ view: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { record("web-failed", ["error": error.localizedDescription]) }
}

func availablePort() -> String {
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { fatalError("Could not reserve the local server port") }
    defer { Darwin.close(fd) }
    var address = sockaddr_in(); address.sin_family = sa_family_t(AF_INET); address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    inet_pton(AF_INET, "127.0.0.1", &address.sin_addr)
    let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
    guard bound == 0 else { fatalError("Could not bind the local server port") }
    var count = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &count) } }
    return String(UInt16(bigEndian: address.sin_port))
}

umask(0o077)
let app = NSApplication.shared
let delegate = MondashApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
