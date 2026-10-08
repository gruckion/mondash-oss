/** Fetch compatibility at the native boundary; one independent connection per request. */
export interface IrohBridge {
  open(id: string, ticket: string, bytes: Uint8Array): Promise<void>;
  read(id: string, limit: number): Promise<Uint8Array>;
  cancel(id: string): Promise<void>;
}

const encoder = new TextEncoder();
const abortError = () => new DOMException("Request cancelled", "AbortError");
let nextId = 0;

/** Effect uses arrayBuffer; the existing live-update owner consumes body directly. */
export type ApiResponse = Pick<
  Response,
  "url" | "status" | "headers" | "body" | "ok" | "arrayBuffer" | "text" | "json"
>;
export type ApiFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<ApiResponse>;

class IrohResponse implements ApiResponse {
  readonly type = "basic";
  readonly redirected = false;
  readonly statusText = "";
  readonly ok: boolean;
  readonly [Symbol.toStringTag] = "Response";
  private used = false;
  constructor(
    readonly url: string,
    readonly status: number,
    readonly headers: Headers,
    public body: ReadableStream<Uint8Array<ArrayBuffer>>,
  ) {
    this.ok = status >= 200 && status < 300;
  }
  get bodyUsed() {
    return this.used || this.body.locked;
  }
  async bytes(): Promise<Uint8Array<ArrayBuffer>> {
    if (this.bodyUsed) throw new TypeError("Response body already consumed");
    this.used = true;
    const reader = this.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.length;
        if (size > 64 * 1024 * 1024) throw new Error("Response too large");
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return bytes;
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return (await this.bytes()).buffer;
  }
  async text() {
    return new TextDecoder().decode(await this.bytes());
  }
  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }
}

export function createIrohFetch(bridge: IrohBridge, ticket: string, origin: string): ApiFetch {
  return async (input, options = {}) => {
    const request = typeof input === "string" || input instanceof URL ? undefined : input;
    const url = new URL(request?.url ?? String(input));
    if (url.origin !== origin || !url.pathname.startsWith("/api/"))
      throw new Error("Request is outside the paired Mac API");
    const signal = options.signal ?? request?.signal;
    if (signal?.aborted) throw abortError();
    const method = (options.method ?? request?.method ?? "GET").toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("Unsupported request method");
    let payload: Uint8Array = new Uint8Array();
    const source = options.body ?? (request ? await request.arrayBuffer() : undefined);
    if (typeof source === "string") payload = encoder.encode(source);
    else if (source instanceof ArrayBuffer) payload = new Uint8Array(source);
    else if (ArrayBuffer.isView(source)) payload = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    else if (source !== undefined && source !== null) throw new Error("Unsupported Mondash request body");
    if (payload.length > 3_000_000) throw new Error("Request too large");
    const headers = new Headers(options.headers ?? request?.headers);
    for (const name of [
      "host",
      "connection",
      "content-length",
      "transfer-encoding",
      "cookie",
      "x-mondash-capability",
      "origin",
    ])
      headers.delete(name);
    headers.set("host", "localhost");
    headers.set("connection", "close");
    if (payload.length || !["GET", "HEAD"].includes(method)) headers.set("content-length", String(payload.length));
    let raw = `${method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
    headers.forEach((value, name) => {
      raw += `${name}: ${value}\r\n`;
    });
    const head = encoder.encode(`${raw}\r\n`);
    const bytes = new Uint8Array(head.length + payload.length);
    bytes.set(head);
    bytes.set(payload, head.length);
    const id = `${Date.now()}-${++nextId}`;
    let pending = new Uint8Array(0);
    let closed = false;
    let controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", abort);
      void bridge.cancel(id).catch(() => {});
    };
    const abort = () => {
      close();
      controller?.error(abortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
    const read = async (limit: number) => {
      if (closed || signal?.aborted) throw abortError();
      return bridge.read(id, limit);
    };
    const append = (chunk: Uint8Array) => {
      const merged = new Uint8Array(pending.length + chunk.length);
      merged.set(pending);
      merged.set(chunk, pending.length);
      pending = merged;
    };
    const need = async (size: number) => {
      while (pending.length < size) {
        const chunk = await read(Math.min(65536, size - pending.length));
        if (!chunk.length) throw new Error("Incomplete response from Mac");
        append(chunk);
      }
      const chunk = pending.slice(0, size);
      pending = pending.slice(size);
      return chunk;
    };
    const line = async () => {
      for (;;) {
        for (let i = 0; i + 1 < pending.length; i++) {
          if (pending[i] === 13 && pending[i + 1] === 10) {
            const value = new TextDecoder().decode(pending.slice(0, i));
            pending = pending.slice(i + 2);
            return value;
          }
        }
        if (pending.length > 16384) throw new Error("Response header too large");
        const chunk = await read(1024);
        if (!chunk.length) throw new Error("Missing response header");
        append(chunk);
      }
    };
    try {
      await bridge.open(id, ticket, bytes);
      if (closed || signal?.aborted) throw abortError();
      const status = Number(/^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(await line())?.[1]);
      if (status < 200 || status > 599 || !status) throw new Error("Invalid response status");
      const responseHeaders = new Headers();
      let headerSize = 0;
      for (;;) {
        const value = await line();
        headerSize += value.length;
        if (headerSize > 16384) throw new Error("Response headers too large");
        if (!value) break;
        const colon = value.indexOf(":");
        if (colon < 1) throw new Error("Invalid response header");
        responseHeaders.append(value.slice(0, colon), value.slice(colon + 1).trim());
      }
      const transfer = responseHeaders.get("transfer-encoding");
      if (transfer && transfer.toLowerCase() !== "chunked") throw new Error("Unsupported response encoding");
      const chunked = Boolean(transfer);
      const length = responseHeaders.get("content-length");
      if (length !== null && !/^\d+$/.test(length)) throw new Error("Invalid response length");
      let remaining = method === "HEAD" || status === 204 || status === 304 ? 0 : length === null ? -1 : Number(length);
      let chunkRemaining = 0;
      const body = new ReadableStream<Uint8Array<ArrayBuffer>>(
        {
          start(c) {
            controller = c;
          },
          async pull(c) {
            try {
              if (closed) throw abortError();
              if (remaining === 0) {
                close();
                c.close();
                return;
              }
              if (chunked) {
                if (!chunkRemaining) {
                  const value = await line();
                  if (!/^[0-9a-f]+(?:;.*)?$/i.test(value)) throw new Error("Invalid response chunk");
                  chunkRemaining = parseInt(value, 16);
                  if (!Number.isSafeInteger(chunkRemaining)) throw new Error("Invalid response chunk size");
                  if (!chunkRemaining) {
                    let trailerSize = 0;
                    for (;;) {
                      const trailer = await line();
                      trailerSize += trailer.length;
                      if (trailerSize > 16384) throw new Error("Response trailers too large");
                      if (!trailer) break;
                    }
                    close();
                    c.close();
                    return;
                  }
                }
                const chunk = await need(Math.min(chunkRemaining, 65536));
                chunkRemaining -= chunk.length;
                if (!chunkRemaining) {
                  const end = await need(2);
                  if (end[0] !== 13 || end[1] !== 10) throw new Error("Invalid chunk terminator");
                }
                c.enqueue(chunk);
                return;
              }
              const chunk = pending.length
                ? await need(Math.min(pending.length, remaining < 0 ? 65536 : remaining, 65536))
                : await read(remaining < 0 ? 65536 : Math.min(remaining, 65536));
              if (!chunk.length) {
                if (remaining > 0) throw new Error("Incomplete response from Mac");
                close();
                c.close();
                return;
              }
              if (remaining > 0) remaining -= chunk.length;
              c.enqueue(new Uint8Array(chunk));
            } catch (error) {
              close();
              if (!signal?.aborted) c.error(error);
            }
          },
          cancel() {
            close();
          },
        },
        { highWaterMark: 0 },
      );
      return new IrohResponse(url.href, status, responseHeaders, body);
    } catch (error) {
      close();
      throw error;
    }
  };
}
