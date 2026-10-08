"""Build the private self-contained Mondash Mac app. User data and invitations stay outside the bundle."""
from pathlib import Path
import json
import os
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / ".cache/desktop-build"
BUNDLE = OUT / "Mondash.app"
SDK = ROOT / ".cache/mac-iroh/transport/iroh-ffi"
env = os.environ.copy()
env.pop("MONDASH_IROH_PAIRING_FILE", None)
bun, gh = shutil.which("bun"), shutil.which("gh")
assert bun and gh, "Build prerequisites: Bun and GitHub CLI. The app bundles both runtimes."
OUT.mkdir(parents=True, exist_ok=True)


def run(args, name, cwd=ROOT, extra=None):
    with (OUT / f"{name}.log").open("w") as log:
        subprocess.run(args, cwd=cwd, env=env | (extra or {}), stdout=log, stderr=subprocess.STDOUT, check=True)


run([bun, "scripts/prepare-iroh.ts"], "sdk")
dependency = json.loads((ROOT / "apps/app/modules/mondash-iroh/dependency.json").read_text())
if not SDK.exists():
    run(["git", "clone", "--depth", "1", "--branch", dependency["irohTag"], "https://github.com/n0-computer/iroh-ffi.git", str(SDK)], "sdk-source")
assert subprocess.check_output(["git", "-C", str(SDK), "rev-parse", "HEAD"], text=True).strip() == dependency["gitCommit"], "SDK does not match the pinned release"
shutil.copytree(ROOT / "apps/app/modules/mondash-iroh/ios/Vendor/Iroh.xcframework", SDK / "Iroh.xcframework", dirs_exist_ok=True)
run([bun, "scripts/build-browser-iroh.ts"], "browser-iroh")
run([bun, "run", "--filter", "@mondash/app", "build:web"], "web")
index = ROOT / "apps/app/dist/index.html"
index.write_text(index.read_text().replace("<head>", '<head><script src="/iroh/bootstrap.js"></script>'))
# Only replace our generated output; never an installed application or its data.
if BUNDLE.exists():
    assert (BUNDLE / "Contents/Resources/.mondash-build").exists() or plistlib.loads((BUNDLE / "Contents/Info.plist").read_bytes())["CFBundleIdentifier"] == "com.mondash.iroh.trial.mac"
    shutil.rmtree(BUNDLE)
for relative in ["Contents/MacOS", "Contents/Helpers", "Contents/Resources"]:
    (BUNDLE / relative).mkdir(parents=True, exist_ok=True)
(BUNDLE / "Contents/Resources/.mondash-build").write_text("Generated Mondash build output\n")
helpers = BUNDLE / "Contents/Helpers"
for entry, name in [("src/backend.ts", "mondash-server"), ("src/browser-main.ts", "mondash-browser")]:
    run([bun, "build", "--compile", "--minify", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", entry, "--outfile", str(helpers / name)], name, cwd=ROOT / "apps/desktop")
run(["swift", "build", "--package-path", "apps/desktop/transport", "--scratch-path", ".cache/desktop-transport", "-c", "release"], "transport", extra={"MONDASH_IROH_SOURCE": str(SDK)})
shutil.copy2(ROOT / ".cache/desktop-transport/release/MondashTransport", helpers / "iroh-transport")
shutil.copy2(gh, helpers / "gh")
shutil.copytree(ROOT / "apps/app/dist", BUNDLE / "Contents/Resources/web")
icon = ROOT / "apps/app/assets/mondash-icon.png"
shutil.copy2(icon, BUNDLE / "Contents/Resources/mondash-icon.png")
iconset = OUT / "Mondash.iconset"
iconset.mkdir(exist_ok=True)
for size in [16, 32, 128, 256, 512]:
    for scale in [1, 2]:
        filename = f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        run(["sips", "-z", str(size * scale), str(size * scale), str(icon), "--out", str(iconset / filename)], f"icon-{size}-{scale}")
run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUNDLE / "Contents/Resources/Mondash.icns")], "icon")
run(["swiftc", "-swift-version", "5", "-framework", "AppKit", "-framework", "WebKit", "-framework", "ServiceManagement", "apps/desktop/Mondash.swift", "-o", str(BUNDLE / "Contents/MacOS/Mondash")], "shell")
info = {"CFBundleExecutable": "Mondash", "CFBundleIdentifier": "com.mondash.iroh.trial.mac", "CFBundleName": "Mondash", "CFBundleDisplayName": "Mondash", "CFBundleIconFile": "Mondash.icns", "CFBundleVersion": "8", "CFBundleShortVersionString": "0.1.0", "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "14.5", "LSUIElement": True, "CFBundleURLTypes": [{"CFBundleURLName": "com.mondash.browser", "CFBundleURLSchemes": ["mondash"]}], "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True}}
(BUNDLE / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
licenses = BUNDLE / "Contents/Resources/licenses"
licenses.mkdir(exist_ok=True)
for name in ["LICENSE-MIT", "LICENSE-APACHE"]:
    shutil.copy2(SDK / name, licenses / name)
shutil.copy2(ROOT / "LICENSE", licenses / "Mondash-MIT")
for helper in helpers.iterdir():
    run(["codesign", "--force", "--sign", "-", str(helper)], "sign-" + helper.name)
run(["codesign", "--force", "--sign", "-", str(BUNDLE)], "sign-app")
run(["codesign", "--verify", "--deep", "--strict", str(BUNDLE)], "verify-app")
print(BUNDLE)
