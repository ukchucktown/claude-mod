import type { Readable, Writable } from "node:stream";
import type { RpcId } from "../contracts.ts";

export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const nonempty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;
export const rpcId = (value: unknown): value is RpcId =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isSafeInteger(value));
export class ConnectionError extends Error {
  readonly details: unknown;
  readonly kind:
    | "protocol"
    | "transport"
    | "timeout"
    | "configuration"
    | "state"
    // A rule of the integration refused the call before the runtime ran it,
    // for example the launcher gate or the lease of another runtime.
    | "policy"
    // A well-formed tool result whose content failed validation. It fails only
    // its own call; the connection and the kernel state stay usable.
    | "content";
  constructor(
    kind: ConnectionError["kind"],
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "ConnectionError";
    this.kind = kind;
    this.details = details;
  }
}
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}
export type Request = {
  jsonrpc: "2.0";
  id: RpcId;
  method: string;
  params?: unknown;
};
export type Notification = { jsonrpc: "2.0"; method: string; params?: unknown };
export const DEFAULT_DEADLINE_MS = 120000;
export const MAX_DEADLINE_MS = 2147483647;
// Lets the request owner stop the deadline clock while the peer waits on a
// decision that the user, not the peer, controls. RpcStream fills the methods.
export type DeadlineControl = { pause(): void; resume(): void };
type Waiter = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout> | undefined;
  settled(): void;
};

// One stream, one ID namespace in each direction. A malformed or unsolicited
// response poisons the connection rather than leaving later calls usable.
export class RpcStream {
  private input: Readable;
  private output: Writable;
  private buffer = "";
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private nextId = 0;
  private waiting = new Map<RpcId, Waiter>();
  private incoming = new Set<RpcId>();
  private seenIncoming = new Set<RpcId>();
  // Outgoing requests that this side cancelled. A late response is ignored.
  private cancelledOutgoing = new Set<RpcId>();
  private fault: Error | undefined;
  readonly maxFrameBytes: number;
  onRequest: (request: Request) => void = (request) =>
    this.error(request.id, -32601, "Unsupported host request");
  onNotification: (notification: Notification) => void = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(
    input: Readable,
    output: Writable,
    maxFrameBytes = 32 * 1024 * 1024,
  ) {
    this.input = input;
    this.output = output;
    this.maxFrameBytes = maxFrameBytes;
    input.on("data", this.data);
    input.on("end", this.ended);
    input.on("close", this.ended);
    input.on("error", this.streamError);
    output.on("error", this.streamError);
  }
  private data = (chunk: string | Uint8Array) => {
    if (this.fault) return;
    try {
      this.buffer +=
        typeof chunk === "string"
          ? chunk
          : this.decoder.decode(chunk, { stream: true });
    } catch {
      this.invalid("Invalid UTF-8 frame");
      return;
    }
    let newline: number;
    while (!this.fault && (newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes)
        return this.invalid("Frame exceeds size limit");
      if (line.trim()) {
        try {
          this.receive(JSON.parse(line));
        } catch (error) {
          this.invalid(
            error instanceof Error ? error.message : "Malformed frame",
          );
        }
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes)
      this.invalid("Frame exceeds size limit");
  };
  private ended = () =>
    this.fail(
      new ConnectionError(
        "transport",
        "Peer stream closed; external effect unknown",
      ),
    );
  private streamError = (error: Error) =>
    this.fail(
      new ConnectionError(
        "transport",
        `${error.message}; external effect unknown`,
      ),
    );
  private invalid(message: string) {
    this.fail(new ConnectionError("protocol", message));
  }
  private receive(frame: unknown) {
    if (!object(frame) || frame.jsonrpc !== "2.0")
      throw new Error("Invalid JSON-RPC envelope");
    if ("method" in frame) {
      if (
        !nonempty(frame.method) ||
        "result" in frame ||
        "error" in frame ||
        ("params" in frame && !object(frame.params))
      )
        throw new Error("Invalid request envelope");
      if ("id" in frame) {
        if (!rpcId(frame.id) || this.seenIncoming.has(frame.id))
          throw new Error("Invalid or duplicate server request ID");
        this.seenIncoming.add(frame.id);
        this.incoming.add(frame.id);
        this.onRequest(frame as Request);
      } else this.onNotification(frame as Notification);
      return;
    }
    if (
      !rpcId(frame.id) ||
      "result" in frame === "error" in frame ||
      "params" in frame
    )
      throw new Error("Invalid response envelope");
    const waiter = this.waiting.get(frame.id);
    if (!waiter) {
      if (this.cancelledOutgoing.delete(frame.id)) return;
      throw new Error("Unknown or duplicate response ID");
    }
    if (
      "error" in frame &&
      (!object(frame.error) ||
        !Number.isInteger(frame.error.code) ||
        typeof frame.error.message !== "string")
    )
      throw new Error("Malformed protocol error");
    this.waiting.delete(frame.id);
    clearTimeout(waiter.timer);
    // Expire execution correlation before another frame in this chunk arrives.
    waiter.settled();
    if (object(frame.error))
      waiter.reject(
        new RpcError(
          frame.error.code as number,
          frame.error.message as string,
          frame.error.data,
        ),
      );
    else waiter.resolve(frame.result);
  }
  private send(frame: unknown) {
    if (this.fault) throw this.fault;
    try {
      const line = JSON.stringify(frame) + "\n";
      if (Buffer.byteLength(line) > this.maxFrameBytes)
        throw new ConnectionError(
          "protocol",
          "Outgoing frame exceeds size limit",
        );
      this.output.write(line, (error) => {
        if (error) this.streamError(error);
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure);
      throw failure;
    }
  }

  // timeoutMs null means no deadline: the answer depends on a person.
  request(
    method: string,
    params: unknown,
    timeoutMs: number | null = DEFAULT_DEADLINE_MS,
    settled = () => {},
    control?: DeadlineControl,
    // Receives the request ID, so the caller can cancel the request later.
    handle?: { id?: RpcId },
  ): Promise<unknown> {
    if (this.fault) return Promise.reject(this.fault);
    const id = ++this.nextId;
    if (handle) handle.id = id;
    return new Promise((resolve, reject) => {
      const expire = () =>
        this.fail(
          new ConnectionError(
            "timeout",
            `${method} deadline expired; external effect unknown; no automatic retry`,
          ),
        );
      let remaining = timeoutMs;
      let startedAt = Date.now();
      const waiter: Waiter = {
        resolve,
        reject,
        timer: remaining === null ? undefined : setTimeout(expire, remaining),
        settled,
      };
      if (control) {
        control.pause = () => {
          if (waiter.timer === undefined || remaining === null) return;
          clearTimeout(waiter.timer);
          waiter.timer = undefined;
          remaining = Math.max(1, remaining - (Date.now() - startedAt));
        };
        control.resume = () => {
          if (waiter.timer !== undefined || remaining === null) return;
          if (!this.waiting.has(id)) return;
          startedAt = Date.now();
          waiter.timer = setTimeout(expire, remaining);
        };
      }
      this.waiting.set(id, waiter);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  // Withdraws a request that still waits for a response: the peer receives an
  // MCP cancellation, the caller's promise rejects, and a late response for
  // this ID is ignored instead of failing the connection.
  cancel(id: RpcId, reason: string) {
    const waiter = this.waiting.get(id);
    if (!waiter || this.fault) return;
    this.waiting.delete(id);
    clearTimeout(waiter.timer);
    waiter.settled();
    this.cancelledOutgoing.add(id);
    waiter.reject(new ConnectionError("state", `Request cancelled: ${reason}`));
    this.notify("notifications/cancelled", { requestId: id, reason });
  }
  notify(method: string, params?: unknown) {
    this.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }
  result(id: RpcId, result: unknown) {
    if (!this.incoming.delete(id))
      throw new ConnectionError("state", "Server request is no longer pending");
    this.send({ jsonrpc: "2.0", id, result });
  }
  error(id: RpcId, code: number, message: string, data?: unknown) {
    if (!this.incoming.delete(id))
      throw new ConnectionError("state", "Server request is no longer pending");
    this.send({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    });
  }
  fail(error: Error) {
    if (this.fault) return;
    this.fault = error;
    for (const waiter of this.waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.settled();
      waiter.reject(error);
    }
    this.waiting.clear();
    this.incoming.clear();
    this.buffer = "";
    this.onFailure(error);
  }
  close() {
    this.fail(
      new ConnectionError(
        "transport",
        "Connection stopped; external effect unknown",
      ),
    );
    this.input.off("data", this.data);
    this.input.off("end", this.ended);
    this.input.off("close", this.ended);
    // Keep stream error listeners until the pipes close to absorb late EPIPE.
    this.output.end();
  }
}
