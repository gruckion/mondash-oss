/** Runs before the dashboard bundle, and also in the offline page. No dashboard data is cached here. */
function browserRecovery() {
  const root = document.documentElement;
  root.dataset.mondashBrowser = "true";
  const waitingPage = root.dataset.mondashRecoveryPage === "true";
  const delays = [1000, 2000, 4000, 8000, 15000, 30000, 60000, 120000, 300000];
  let attempts = 0,
    active = waitingPage,
    denied = false;
  let reconnecting = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: AbortController | undefined;
  let panel: HTMLElement | undefined;
  const change = (recovering: boolean) => {
    root.dataset.mondashRecovering = String(recovering);
    window.dispatchEvent(new Event("mondash:recovery-change"));
  };
  const show = () => {
    if (!document.body) return;
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = "mondash-recovery";
      panel.setAttribute("aria-live", "polite");
      panel.style.cssText =
        "position:fixed;z-index:2147483647;bottom:24px;left:50%;transform:translateX(-50%);width:max-content;max-width:calc(100% - 32px);box-sizing:border-box;padding:14px 18px;border:1px solid #3f3f46;border-radius:18px;background:#18181bf2;color:#f4f4f5;font:14px system-ui;box-shadow:0 8px 32px #0006;display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:14px";
      const label = document.createElement("span");
      label.id = "mondash-recovery-label";
      panel.append(label);
      const retry = document.createElement("button");
      retry.textContent = "Retry now";
      retry.style.cssText =
        "border:0;border-radius:10px;padding:9px 12px;background:#3f3f46;color:inherit;font:inherit;cursor:pointer";
      retry.addEventListener("click", () => {
        attempts = 0;
        denied = false;
        void check();
      });
      panel.append(retry);
      const open = document.createElement("a");
      open.id = "mondash-recovery-open";
      open.href = "mondash://browser";
      open.style.cssText = "color:#c4b5fd;text-decoration:none;white-space:nowrap";
      open.addEventListener("click", async (event) => {
        if (!denied) return;
        event.preventDefault();
        if (reconnecting) return;
        reconnecting = true;
        try {
          const response = await fetch("/_browser/request", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(2500),
          });
          const request: unknown = await response.json();
          if (
            !response.ok ||
            typeof request !== "object" ||
            request === null ||
            !("url" in request) ||
            typeof request.url !== "string" ||
            !/^mondash:\/\/browser\?request=[a-f0-9]{64}$/.test(request.url)
          )
            throw Error("Reconnect unavailable");
          denied = false;
          attempts = 0;
          schedule();
          location.href = request.url;
        } catch {
          document.getElementById("mondash-recovery-label")!.textContent = "Open Mondash, then retry";
        } finally {
          reconnecting = false;
        }
      });
      open.addEventListener("click", () => {
        if (denied) return;
        denied = false;
        attempts = 0;
        schedule();
      });
      panel.append(open);
      document.body.append(panel);
    }
    panel.hidden = false;
    document.getElementById("mondash-recovery-label")!.textContent = denied
      ? "Reconnect this browser"
      : "Waiting for Mondash…";
    document.getElementById("mondash-recovery-open")!.textContent = denied ? "Reconnect browser" : "Open Mondash";
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!active || denied || document.hidden || pending) return;
    timer = setTimeout(() => void check(), delays[Math.min(attempts++, delays.length - 1)]);
  };
  const check = async () => {
    clearTimeout(timer);
    if (!active || document.hidden || pending) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch("/_browser/status", {
        cache: "no-store",
        signal: controller.signal,
        credentials: "same-origin",
      });
      const status: unknown = await response.json();
      if (
        response.ok &&
        typeof status === "object" &&
        status !== null &&
        "state" in status &&
        status.state === "ready"
      ) {
        active = false;
        attempts = 0;
        denied = false;
        if (waitingPage) {
          location.reload();
          return;
        }
        panel?.remove();
        panel = undefined;
        change(false);
        return;
      }
      denied = response.status === 401;
      show();
    } catch {
      show();
    } finally {
      clearTimeout(timeout);
      pending = undefined;
      schedule();
    }
  };
  const begin = () => {
    if (active) return;
    active = true;
    attempts = 0;
    change(true);
    show();
    void check();
  };
  window.addEventListener("mondash:connection-lost", begin);
  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (document.hidden) {
      pending?.abort();
      return;
    }
    if (active && !denied) {
      attempts = 0;
      void check();
    }
  });
  window.addEventListener("online", () => {
    if (active && !denied) {
      attempts = 0;
      void check();
    }
  });
  window.addEventListener("pagehide", () => {
    clearTimeout(timer);
    pending?.abort();
    active = false;
  });
  window.addEventListener("pageshow", () => {
    if (root.dataset.mondashRecovering === "true") {
      active = true;
      void check();
    }
  });
  // navigator.onLine is deliberately not a gate: this Mac's localhost works without Internet access.
  if ("serviceWorker" in navigator)
    void navigator.serviceWorker.register("/_browser/worker.js", { scope: "/" }).catch(() => {});
  if (waitingPage) {
    change(true);
    if (document.readyState === "loading")
      document.addEventListener(
        "DOMContentLoaded",
        () => {
          show();
          void check();
        },
        { once: true },
      );
    else {
      show();
      void check();
    }
  }
}

export const recoveryScript = `(${browserRecovery.toString()})();`;
export const recoveryPage = `<!doctype html><html data-mondash-recovery-page="true"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mondash</title><style>body{background:#0b0b0c;color:#f4f4f5;font:17px system-ui;margin:18vh auto;max-width:420px;padding:24px}p{color:#a1a1aa}#mondash-recovery{position:static!important;transform:none!important;margin-top:28px;width:100%!important;max-width:100%!important}</style></head><body><h1>Mondash</h1><p>Your dashboard will return automatically.</p><script>${recoveryScript}</script></body></html>`;
export const recoveryWorker = `const fallback=${JSON.stringify(recoveryPage)};
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()));
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
self.addEventListener('fetch',event=>{
 if(event.request.mode==='navigate' && new URL(event.request.url).origin===self.location.origin && !new URL(event.request.url).pathname.startsWith('/_handoff') && !new URL(event.request.url).pathname.startsWith('/api/'))
  event.respondWith(fetch(event.request).catch(()=>new Response(fallback,{status:503,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}})));
});`;
