import { afterAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { translations } from "../web/src/lib/i18n/translations";
// Compile the actual rune store, not a hand-maintained copy of its logic.
// @ts-expect-error The UI has its own dependency tree.
import { compileModule } from "../web/node_modules/svelte/compiler";

const dir = mkdtempSync(join(import.meta.dir, "../web/.dreaming-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(
  new URL("../web/src/lib/stores/memories-explorer.svelte.ts", import.meta.url),
  "utf8"
)
  .replace(/^import .*;\n/gm, "")
  .replace(
    "export function createMemoriesExplorer() {",
    "export function createMemoriesExplorer({ fetchAPI, askConfirm, toast, toastApiResult, t }) {"
  );
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(source);
const compiled = compileModule(js, { generate: "server", filename: "explorer.svelte.js" });
writeFileSync(join(dir, "store.mjs"), compiled.js.code);
const { createMemoriesExplorer } = await import(pathToFileURL(join(dir, "store.mjs")).href);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
function harness() {
  const calls: string[] = [];
  const messages: string[] = [];
  let confirms = 0;
  const state = {
    status: { success: true, data: { enabled: true, isRunning: false } } as any,
    run: { success: true, data: {} } as any,
    confirm: Promise.resolve(true),
    reloadThrows: false,
  };
  const store = createMemoriesExplorer({
    fetchAPI: async (path: string, options?: { timeout?: number }) => {
      calls.push(path);
      if (path.endsWith("/status")) {
        expect(options?.timeout).toBe(10_000);
        return await state.status;
      }
      if (path.endsWith("/run")) return await state.run;
      if (state.reloadThrows) throw new Error("reload failed");
      return { success: true, data: { items: [], totalPages: 1, total: 0, page: 1 } };
    },
    askConfirm: () => {
      confirms++;
      return state.confirm;
    },
    toast: Object.fromEntries(
      ["info", "error", "success", "warning"].map((level) => [
        level,
        (s: string) => messages.push(s),
      ])
    ),
    toastApiResult: async (result: any, options: any) => {
      if (result.success) await options.onSuccess?.();
    },
    t: (key: string) => key,
  });
  return {
    store,
    state,
    calls,
    messages,
    get confirms() {
      return confirms;
    },
  };
}

describe("dreaming UI availability", () => {
  it("explains unavailable states in every supported locale", () => {
    for (const locale of Object.values(translations)) {
      expect(locale["dreaming-disabled"]).toContain("dreaming.enabled");
      expect(locale["dreaming-status-loading"].length).toBeGreaterThan(0);
      expect(locale["dreaming-status-error"].length).toBeGreaterThan(0);
    }
  });

  it("fails closed on initial load, disabled config, running, malformed data and errors; recovers", async () => {
    const h = harness();
    expect(h.store.dreamingUnavailableReason).toBe("dreaming-status-loading");
    await h.store.runDreaming();
    expect(h.confirms).toBe(0);
    for (const [status, reason] of [
      [{ success: true, data: { enabled: false, isRunning: false } }, "dreaming-disabled"],
      [
        { success: true, data: { enabled: true, isRunning: true } },
        "toast-dreaming-already-running",
      ],
      [{ success: true, data: {} }, "dreaming-status-error"],
      [{ success: false }, "dreaming-status-error"],
    ]) {
      h.state.status = status;
      await h.store.loadDreamingStatus();
      expect(h.store.dreamingUnavailableReason).toBe(reason);
      await h.store.runDreaming();
    }
    expect(h.confirms).toBe(0);
    h.state.status = { success: true, data: { enabled: true, isRunning: false } };
    await h.store.loadDreamingStatus();
    expect(h.store.dreamingUnavailableReason).toBeNull();
  });

  it("ignores out-of-order status responses", async () => {
    const h = harness();
    const old = deferred<any>();
    h.state.status = old.promise;
    const first = h.store.loadDreamingStatus();
    h.state.status = { success: true, data: { enabled: false, isRunning: false } };
    await h.store.loadDreamingStatus();
    old.resolve({ success: true, data: { enabled: true, isRunning: false } });
    await first;
    expect(h.store.dreamingUnavailableReason).toBe("dreaming-disabled");
  });

  it("guards duplicate confirmation and releases on cancellation", async () => {
    const h = harness();
    await h.store.loadDreamingStatus();
    const confirm = deferred<boolean>();
    h.state.confirm = confirm.promise;
    const first = h.store.runDreaming();
    await h.store.runDreaming();
    expect(h.confirms).toBe(1);
    confirm.resolve(false);
    await first;
    expect(h.store.dreamingBusy).toBe(false);
    expect(h.calls).not.toContain("/api/dreaming/run");
  });

  it("rechecks config after confirmation and localizes a stale disabled response", async () => {
    const h = harness();
    await h.store.loadDreamingStatus();
    h.state.status = { success: true, data: { enabled: false, isRunning: false } };
    await h.store.runDreaming();
    expect(h.calls).not.toContain("/api/dreaming/run");
    h.state.status = { success: true, data: { enabled: true, isRunning: false } };
    await h.store.loadDreamingStatus();
    h.state.run = { success: false, error: "dreaming_disabled" };
    await h.store.runDreaming();
    expect(h.messages).toContain("dreaming-disabled");
  });

  it("reconciles a timed-out run and recovers after a status failure", async () => {
    const h = harness();
    await h.store.loadDreamingStatus();
    const run = deferred<any>();
    h.state.run = run.promise;
    const pending = h.store.runDreaming();
    while (!h.calls.includes("/api/dreaming/run")) await Promise.resolve();
    h.state.status = { success: true, data: { enabled: true, isRunning: true } };
    run.resolve({ success: false, error: "request timed out" });
    await pending;
    expect(h.store.dreamingBusy).toBe(false);
    expect(h.store.dreamingUnavailableReason).toBe("toast-dreaming-already-running");
    h.state.status = Promise.reject(new Error("offline"));
    await h.store.loadDreamingStatus();
    expect(h.store.dreamingUnavailableReason).toBe("dreaming-status-error");
    h.state.status = { success: true, data: { enabled: true, isRunning: false } };
    await h.store.loadDreamingStatus();
    expect(h.store.dreamingUnavailableReason).toBeNull();
  });

  it("releases busy even when reloading memories fails", async () => {
    const h = harness();
    await h.store.loadDreamingStatus();
    h.state.reloadThrows = true;
    await h.store.runDreaming();
    expect(h.store.dreamingBusy).toBe(false);
    expect(h.store.dreamingUnavailableReason).toBeNull();
  });
});
