import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchPublicSource } from "./collector";
const { lookup, get } = vi.hoisted(() => ({ lookup: vi.fn(), get: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:https", () => ({ default: { get } }));
beforeEach(() => {
  lookup.mockReset();
  get.mockReset();
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
  delete process.env.AERION_EXTRA_CA_FILE;
});
function reply(code: number, headers: Record<string, string>, body = "source") {
  get.mockImplementationOnce((_url, _options, callback) => {
    const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn> };
    request.setTimeout = vi.fn();
    queueMicrotask(() => {
      const response = new PassThrough() as PassThrough & {
        statusCode: number;
        headers: Record<string, string>;
      };
      response.statusCode = code;
      response.headers = headers;
      callback(response);
      response.end(body);
    });
    return request;
  });
}
describe("Bounded HTTPS collector transport", () => {
  it("pins the public DNS answer and retains the exact response", async () => {
    reply(200, { "content-type": "text/plain" }, "Original source\n");
    expect((await fetchPublicSource("https://example.com/source")).original.toString()).toBe(
      "Original source\n",
    );
    const options = get.mock.calls[0][1];
    const address = vi.fn();
    options.lookup("example.com", {}, address);
    expect(address).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it("rejects mixed private/public DNS answers before opening a connection", async () => {
    lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("private or reserved");
    expect(get).not.toHaveBeenCalled();
  });
  it("refuses cross-origin redirects before requesting their target", async () => {
    reply(302, { location: "https://another.example.com/feed" });
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("another origin");
    expect(get).toHaveBeenCalledTimes(1);
  });
  it("revalidates and permits a bounded same-origin redirect", async () => {
    reply(301, { location: "/feed" });
    reply(200, { "content-type": "text/plain" }, "Retained");
    expect((await fetchPublicSource("https://example.com")).url).toBe("https://example.com/feed");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it("refuses oversized, compressed and restricted responses", async () => {
    reply(200, { "content-length": "2000001" });
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("2 MB");
    reply(200, { "content-encoding": "gzip" });
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("Compressed");
    reply(403, {});
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("HTTP 403");
  });
  it("surfaces TLS verification failure without falling back to an insecure request", async () => {
    get.mockImplementationOnce(() => {
      const request = new EventEmitter() as EventEmitter & { setTimeout: ReturnType<typeof vi.fn> };
      request.setTimeout = vi.fn();
      queueMicrotask(() => request.emit("error", new Error("untrusted certificate chain")));
      return request;
    });
    await expect(fetchPublicSource("https://example.com")).rejects.toThrow("certificate");
    expect(get).toHaveBeenCalledTimes(1);
  });
});
