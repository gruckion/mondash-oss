import { startBrowserGateway } from "./browser-gateway";
const env = process.env;
if (!env.MONDASH_BACKEND || !env.MONDASH_LOCAL_CAPABILITY || !env.MONDASH_WEB_ROOT || !env.MONDASH_DATA)
  throw new Error("Mondash browser configuration missing");
const gateway = await startBrowserGateway({
  backend: env.MONDASH_BACKEND,
  capability: env.MONDASH_LOCAL_CAPABILITY,
  webRoot: env.MONDASH_WEB_ROOT,
  data: env.MONDASH_DATA,
  browserOrigin: env.MONDASH_BROWSER_ORIGIN,
});
const stop = () => {
  gateway.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const owner = Number(env.MONDASH_PARENT_PID);
if (owner)
  setInterval(() => {
    try {
      process.kill(owner, 0);
    } catch {
      stop();
    }
  }, 500).unref();
