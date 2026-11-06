import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const source = (path: string) => JSON.stringify(new URL(`../src/${path}.js`, import.meta.url).href);
type ResponseKind = "missing" | "merge" | "keep" | "invalid" | "auth" | "timeout";

function runScenario(
  responses: ResponseKind[],
  options: {
    transport?: "sdk" | "fetch";
    storageFailure?: boolean;
    twoGroups?: boolean;
    deleteFailure?: boolean;
  } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), "dream-retry-"));
  tempDirs.push(dir);
  const scriptPath = join(dir, "scenario.mjs");
  writeFileSync(
    scriptPath,
    `
import { mock } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
const responses = ${JSON.stringify(responses)};
const options = ${JSON.stringify(options)};
const events = [], logs = [], prompts = [], creates = [];
const storagePath = ${JSON.stringify(dir)};
let sessions = 0, calls = 0, released = 0, externalCalls = 0;
mock.module(${source("config")}, () => ({ CONFIG: {
  storagePath, opencodeProvider: "deepseek", opencodeModel: "test-model", opencodeVariant: "low",
  memory: { defaultScope: "project" },
  dreaming: { enabled: true, maxGroupsPerRun: 5, relatedThreshold: 0.8, crossProject: false,
    trashRetentionDays: 30, intervalHours: 24 }
}}));
mock.module(${source("services/logger")}, () => ({ log: (message, data) => logs.push({ message, data }) }));
mock.module(${source("services/turso/ready")}, () => ({ ensureTursoReady: async () => {} }));
mock.module(${source("services/dreaming-lock")}, () => ({ tryAcquireDreamingLock: () => () => { released++; } }));
const rows = [
  { id: "a", content: "PRIVATE_MEMORY_ALPHA", container_tag: "p1", created_at: 1, is_pinned: 0, vector_json: "[1,0]" },
  { id: "b", content: "PRIVATE_MEMORY_BETA", container_tag: "p1", created_at: 2, is_pinned: 0, vector_json: "[0.99,0.01]" },
  ...(options.twoGroups ? [
    { id: "c", content: "PRIVATE_MEMORY_GAMMA", container_tag: "p1", created_at: 3, is_pinned: 0, vector_json: "[0,1]" },
    { id: "d", content: "PRIVATE_MEMORY_DELTA", container_tag: "p1", created_at: 4, is_pinned: 0, vector_json: "[0.01,0.99]" }
  ] : [])
];
mock.module(${source("services/turso/shard-manager")}, () => ({ tursoShardManager: {
  getAllShards: async (kind) => kind === "project" ? [{ id: "p1", dbPath: "/synthetic/p1.db" }] : []
}}));
mock.module(${source("services/turso/connection-manager")}, () => ({ tursoConnectionManager: {
  getConnection: async () => ({ transaction: async (_kind, apply) => {
    events.push("transaction");
    await apply({ execute: async () => { events.push("write"); } });
  } })
}}));
mock.module(${source("services/turso/vector-utils")}, () => ({
  parseExtractedVector: (v) => new Float32Array(JSON.parse(v)), formatTagsForEmbedding: (v) => v.join(",")
}));
mock.module(${source("services/turso/vector-search")}, () => ({ tursoVectorSearch: {
  getAllMemoriesWithExtractedVectors: async () => rows,
  getMemoryById: async (_db, id) => rows.find(row => row.id === id),
  softDeleteVector: async (_db, id) => { events.push("soft-delete:" + id); return true; }
}}));
mock.module(${source("services/embedding")}, () => ({ embeddingService: {
  warmup: async () => {},
  embedWithTimeout: async () => {
    events.push("embed");
    if (options.storageFailure) throw new Error("PRIVATE_STORAGE_ERROR");
    return new Float32Array([1, 0]);
  }
}}));
const provider = await import(${source("services/ai/opencode-provider")});
provider.setStructuredOutputTimeoutMsForTests(15);
async function prompt(args) {
  prompts.push(args);
  events.push("prompt:" + args.sessionID);
  const kind = responses[calls++];
  if (kind === "timeout") return new Promise(() => {});
  if (kind === "auth") return { info: { error: { name: "ProviderRequestError", data: { message: "401 Unauthorized PRIVATE_PROVIDER_ERROR" } } }, parts: [] };
  if (kind === "missing") return { info: {}, parts: [] };
  if (kind === "invalid") return { info: { structured_output: { action: "PRIVATE_INVALID_ACTION" } }, parts: [] };
  if (kind === "keep") return { info: { structured_output: { action: "keep" } }, parts: [] };
  if (kind !== "merge") throw new Error("Unexpected extra generation");
  return { info: { structured_output: { action: "merge", content: "PRIVATE_GENERATED_MEMORY", keepId: "a", dropIds: ["b"] } }, parts: [] };
}
const client = { session: {
  create: async (args) => { const id = "ses_" + ++sessions; creates.push(args); events.push("create:" + id); return { data: { id } }; },
  prompt: async (args) => ({ data: await prompt(args) }),
  delete: async ({ sessionID }) => { events.push("delete:" + sessionID); if (options.deleteFailure) throw new Error("cleanup failed"); },
  abort: async ({ sessionID }) => { events.push("abort:" + sessionID); }
}};
if (options.transport === "fetch") {
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url), method = req.method;
    if (url.host !== "127.0.0.1:9999") { externalCalls++; throw new Error("No external fallback permitted"); }
    const body = req.body ? await req.json() : {};
    if (method === "POST" && url.pathname === "/session") {
      const id = "ses_" + ++sessions; creates.push(body); events.push("create:" + id);
      return Response.json({ id });
    }
    const sessionID = url.pathname.split("/")[2];
    if (method === "POST" && url.pathname.endsWith("/message")) return Response.json(await prompt({ ...body, sessionID }));
    if (method === "DELETE") { events.push("delete:" + sessionID); return Response.json(true); }
    if (url.pathname.endsWith("/abort")) { events.push("abort:" + sessionID); return Response.json(true); }
    throw new Error("unexpected fetch");
  };
  provider.setV2Client(provider.createV2Client("http://127.0.0.1:9999"));
  // createV2Client without custom transport uses raw fetch for older hosts.
  provider.createV2Client("http://127.0.0.1:9999");
} else {
  globalThis.fetch = async () => { externalCalls++; throw new Error("No external fallback permitted"); };
  provider.setV2Client(client);
}
const { DreamingService } = await import(${source("services/dreaming-service")});
const service = new DreamingService();
const out = await service.run("/synthetic/project");
const stateFile = storagePath + "/dreaming-state.json";
console.log(JSON.stringify({ out, events, logs, prompts, creates, calls, sessions, released,
  externalCalls, isRunning: service.getStatus().isRunning,
  internalSessions: Array.from({length: sessions}, (_, i) => provider.isInternalStructuredSession("ses_" + (i + 1))),
  state: existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : null }));
// Provider cleanup deliberately retains a 60-second idle-event grace timer.
process.exit(0);
`
  );
  const result = Bun.spawnSync({
    cmd: [process.execPath, scriptPath],
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(Buffer.from(result.stderr).toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(Buffer.from(result.stdout).toString());
  return parsed;
}

function expectClean(result: ReturnType<typeof runScenario>) {
  expect(result.released).toBe(1);
  expect(result.isRunning).toBe(false);
  expect(result.internalSessions.every((active: boolean) => !active)).toBe(true);
  expect(result.externalCalls).toBe(0);
  expect(JSON.stringify(result.logs)).not.toContain("PRIVATE_");
}

describe("dreaming missing-output recovery", () => {
  for (const transport of ["sdk", "fetch"] as const) {
    it(`retries generation once with a fresh ${transport} session before a single mutation`, () => {
      const result = runScenario(["missing", "merge"], { transport });
      expect(result.calls).toBe(2);
      expect(result.events).toEqual([
        "create:ses_1",
        "prompt:ses_1",
        "delete:ses_1",
        "create:ses_2",
        "prompt:ses_2",
        "delete:ses_2",
        "soft-delete:b",
        "embed",
        "transaction",
        "write",
        "write",
      ]);
      expect(result.out.groupsFailed).toBe(0);
      expect(result.out.groupsMerged).toBe(1);
      expect(result.out.memoriesSoftDeleted).toBe(1);
      expect(result.state.lastRunAt).toBeGreaterThan(0);
      for (const prompt of result.prompts) {
        expect(prompt.variant).toBe("low");
        expect(prompt.model).toEqual({ providerID: "deepseek", modelID: "test-model" });
        expect(prompt.tools).toEqual({ "*": false, StructuredOutput: true });
        expect(prompt.format.retryCount).toBe(1);
      }
      for (const created of result.creates)
        expect(created.permission).toEqual([
          { permission: "*", pattern: "*", action: "deny" },
          { permission: "StructuredOutput", pattern: "*", action: "allow" },
        ]);
      expectClean(result);
    });
  }

  it("does not retry a valid first response", () => {
    const result = runScenario(["merge"]);
    expect(result.calls).toBe(1);
    expect(result.out).toMatchObject({ groupsMerged: 1, groupsFailed: 0 });
    expectClean(result);
  });

  it("does not retry again when the second response fails validation", () => {
    const result = runScenario(["missing", "invalid"]);
    expect(result.calls).toBe(2);
    expect(result.out).toMatchObject({ groupsFailed: 1, groupsMerged: 0 });
    expect(result.events).not.toContain("embed");
    expectClean(result);
  });

  it("counts a twice-empty group once, leaves storage untouched and does not advance the schedule", () => {
    const result = runScenario(["missing", "missing"]);
    expect(result.calls).toBe(2);
    expect(result.out).toMatchObject({
      groupsConsidered: 1,
      groupsFailed: 1,
      groupsMerged: 0,
      groupsSkipped: 0,
      memoriesSoftDeleted: 0,
    });
    expect(result.events).not.toContain("embed");
    expect(result.events.some((event: string) => event.startsWith("soft-delete"))).toBe(false);
    expect(result.state).toBeNull();
    expect(
      result.logs.find((entry: { message: string }) => entry.message === "dreaming: group failed")
        .data
    ).toMatchObject({
      channel: "opencode",
      configuredProvider: "deepseek",
      configuredModel: "test-model",
      variant: "low",
      attempt: 2,
      phase: "generation",
      error: "missing_structured_output",
    });
    expectClean(result);
  });

  for (const response of ["invalid", "auth", "timeout"] as const) {
    it(`does not retry ${response} failures or mutate storage`, () => {
      const result = runScenario([response]);
      expect(result.calls).toBe(1);
      expect(result.out.groupsFailed).toBe(1);
      expect(result.events).not.toContain("embed");
      expect(result.state).toBeNull();
      if (response === "timeout") expect(result.events).toContain("abort:ses_1");
      expectClean(result);
    });
  }

  it("never retries mutations, even after generation recovery and a partial soft-delete", () => {
    const result = runScenario(["missing", "merge"], { storageFailure: true });
    expect(result.calls).toBe(2);
    expect(result.events.filter((event: string) => event === "soft-delete:b")).toHaveLength(1);
    expect(result.events.filter((event: string) => event === "embed")).toHaveLength(1);
    expect(result.out.groupsFailed).toBe(1);
    expect(result.state).toBeNull();
    expectClean(result);
  });

  it("continues to later groups after exhausted missing-output recovery", () => {
    const result = runScenario(["missing", "missing", "keep"], { twoGroups: true });
    expect(result.calls).toBe(3);
    expect(result.out).toMatchObject({ groupsConsidered: 2, groupsFailed: 1, groupsSkipped: 1 });
    expect(result.state.lastRunAt).toBeGreaterThan(0);
    expectClean(result);
  });

  it("aborts remaining groups on authentication failure without retry", () => {
    const result = runScenario(["auth"], { twoGroups: true });
    expect(result.calls).toBe(1);
    expect(result.out).toMatchObject({ groupsConsidered: 2, groupsFailed: 2, groupsSkipped: 0 });
    expect(result.state).toBeNull();
    expectClean(result);
  });

  it("continues after best-effort session cleanup fails without relaxing permissions", () => {
    const result = runScenario(["missing", "keep"], { deleteFailure: true });
    expect(result.calls).toBe(2);
    expect(result.out).toMatchObject({ groupsFailed: 0, groupsSkipped: 1 });
    expectClean(result);
  });
});
