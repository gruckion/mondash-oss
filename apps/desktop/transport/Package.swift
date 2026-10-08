// swift-tools-version: 5.9
import PackageDescription
import Foundation
let dependency: Package.Dependency = ProcessInfo.processInfo.environment["MONDASH_IROH_SOURCE"].map { .package(path: $0) } ?? .package(url: "https://github.com/n0-computer/iroh-ffi.git", exact: "1.1.0")
let package = Package(name: "MondashTransport", platforms: [.macOS("14.5")], dependencies: [dependency], targets: [.executableTarget(name: "MondashTransport", dependencies: [.product(name: "IrohLib", package: "iroh-ffi")])])
