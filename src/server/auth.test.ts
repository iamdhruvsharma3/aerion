import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({ auth: { getUser: auth.getUser } }),
}));
const lookup = vi.hoisted(() => vi.fn());
vi.mock("./db", () => ({ workspaceFor: lookup }));
import { requireScope } from "./auth";
import { sameOrigin } from "./http";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe("access boundaries", () => {
  it("refuses the local development identity in production", async () => {
    vi.stubEnv("AERION_LOCAL_AUTH", "true");
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      requireScope(new Request("http://localhost:3000/api/session")),
    ).rejects.toMatchObject({ status: 403 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("refuses a public Host even when Next canonicalizes the URL to localhost", async () => {
    vi.stubEnv("AERION_LOCAL_AUTH", "true");
    vi.stubEnv("NODE_ENV", "development");
    await expect(
      requireScope(
        new Request("http://localhost:3000/api/session", {
          headers: { Host: "elsewhere.example" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("accepts a valid same-origin local mutation with a canonicalized request URL", () => {
    expect(() =>
      sameOrigin(
        new Request("http://localhost:3000/api/workspace", {
          headers: { Host: "127.0.0.1:3000", Origin: "http://127.0.0.1:3000" },
        }),
      ),
    ).not.toThrow();
  });
  it("uses server-confirmed identity and rejects unauthenticated Supabase requests", async () => {
    vi.stubEnv("AERION_LOCAL_AUTH", "false");
    vi.stubEnv("SUPABASE_URL", "https://project.example");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    auth.getUser.mockResolvedValue({ data: { user: null }, error: new Error("Expired") });
    await expect(
      requireScope(new Request("https://aerion.example/api/session")),
    ).rejects.toMatchObject({ status: 401 });
    expect(lookup).not.toHaveBeenCalled();
  });
  it("scopes an authenticated request to the verified user", async () => {
    vi.stubEnv("AERION_LOCAL_AUTH", "false");
    vi.stubEnv("SUPABASE_URL", "https://project.example");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
    const id = "00000000-0000-4000-8000-000000000002";
    auth.getUser.mockResolvedValue({ data: { user: { id } }, error: null });
    lookup.mockResolvedValue({ actorId: id, workspaceId: "verified-workspace" });
    await expect(requireScope(new Request("https://aerion.example/api/session"))).resolves.toEqual({
      actorId: id,
      workspaceId: "verified-workspace",
    });
    expect(lookup).toHaveBeenCalledWith(id);
  });
});
