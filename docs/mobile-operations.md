# Optional iPhone access

Finish desktop setup first. The Mac stays awake and online; both devices must be on your private Tailscale network. Publish the backend with a separate Serve port, preserving any existing routes:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3456
tailscale serve status
```

Put your own `https://<mac>.<tailnet>.ts.net:8443` in `runtime.publicUrl` (or MONDASH_PUBLIC_URL), restart the backend, and set that URL in the phone app's Settings. It has no application login; use private Serve, never public Funnel. Desktop use needs neither Tailscale nor Metro.

## Running an OSS preview beside an existing installation

Set `MONDASH_APP_VARIANT=oss` in `apps/app/.env.local` for the name **Mondash OSS**, slug `mondash-oss` and URL scheme `mondash-oss`. Use a distinct `MONDASH_IOS_BUNDLE_ID`, for example `com.yourname.mondash.oss`; iOS uses that identifier to keep the installation and settings separate. A different slug alone does not provide isolation.

Use a second backend port, a separate Tailscale Serve port and `MONDASH_SERVICE_PREFIX=com.mondash.oss` when installing its launch agent. Its profile, cache and logs stay in its own checkout. Set its public URL and the native `EXPO_PUBLIC_API_URL` to that second Serve address. Disable notifications in the preview to avoid duplicate alerts.

For a same-Mac preview using an existing account, optional server-only `MONDASH_OAUTH_READ_ONLY_DIR=/absolute/path/to/original/.mcp-auth` borrows Slack/Notion access tokens without ever refreshing or writing them. The original backend owns refresh and reconnect. If sign-in expires, reconnect in the original app, then retry. This is a preview convenience; independent users use their own normal sign-in and token store.

To replace an existing app for a trial, explicitly use its existing bundle ID and increase its build number. Save the prior signed `.app` before installing the replacement; install over it rather than uninstalling, so its sandbox survives. The OSS slug uses its own saved API-address preference and defaults to `EXPO_PUBLIC_API_URL`, leaving the original address preference available when restoring the prior build. This preserves the original server choice; it is not a full backup of every shared preference or phone file. The original Mac backend can continue running separately.

The latest native app includes a local callback relay for Claude sign-in. Expo Go cannot load that custom native module: use a signed native build to exercise it. Session search and archive controls are available in the updated app; Claude archive state is read from Claude Desktop, while Codex archive changes are confirmed by its native state.

## Expo Go development

```sh
MONDASH_TAILNET_IP=<your-Mac-tailnet-IPv4> bun run services install metro
bun run services start metro
```

The default advertised address is localhost; set your own reachable address for a physical device. Open `exp://<your-Mac-tailnet-IPv4>:8081` in Expo Go. iPhone Expo Go may require the same Expo account as the Mac CLI; see [Expo's requirements](https://docs.expo.dev/troubleshooting/expo-go-sign-in-required/). `runtime.expoGoUrl` is optional.

## Your own signed build

Install Xcode, pair your device and select your own Apple team. In ignored `apps/app/.env.local`, set your identity/build values:

```sh
MONDASH_IOS_BUNDLE_ID=com.yourname.mondash
MONDASH_APPLE_TEAM_ID=<your-team>
MONDASH_IOS_BUILD_NUMBER=1
EXPO_PUBLIC_API_URL=https://<your-Mac>.<tailnet>.ts.net:8443
```

No maintainer signing team is embedded in the default config. `app.config.ts` applies these overrides using [Expo dynamic configuration](https://docs.expo.dev/workflow/configuration/). Preserve the bundle ID when updating an existing installed app to retain its settings. Raise the build number for each install.

```sh
cd apps/app
bunx expo prebuild --platform ios --clean
bunx expo run:ios --configuration Release --no-bundler --device
```

The generated `ios/` folder is ignored. The Release build embeds JavaScript/assets and needs no Metro to run. Changing .env.local does not update an installed bundle; rebuild/reinstall, or change the API URL in app Settings. App Store/TestFlight distribution and a friend's signing/provisioning are separate, unverified release steps.
