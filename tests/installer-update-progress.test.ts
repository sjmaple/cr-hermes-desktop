// @vitest-environment node
import { EventEmitter } from "events";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  child: null as
    | (EventEmitter & { stdout: EventEmitter; stderr: EventEmitter })
    | null,
}));
vi.mock("fs", async (original) => ({
  ...(await original<typeof import("fs")>()),
  existsSync: () => true,
}));
vi.mock("electron", () => ({
  app: { getPath: () => process.env.HERMES_HOME, setPath: vi.fn() },
}));
vi.mock("../src/main/config", () => ({
  getConnectionConfig: vi.fn(),
  getModelConfig: vi.fn(),
  hasOAuthCredentials: vi.fn(),
}));
vi.mock("../src/main/utils", () => ({
  getActiveProfileNameSync: () => undefined,
  profileHome: () => process.env.HERMES_HOME,
  stripAnsi: (text: string) => text,
}));
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  spawn: vi.fn(() => {
    state.child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    return state.child;
  }),
}));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  state.child = null;
});

// @lat: [[desktop-updates#Agent phases#Local command is not measured progress]]
it.each([0, 1])(
  "keeps the actual local update command indeterminate until it exits (%i)",
  async (code) => {
    const home = mkdtempSync(join(tmpdir(), "hermes-agent-update-progress-"));
    vi.stubEnv("HERMES_HOME", home);
    try {
      const { runHermesUpdate } = await import("../src/main/installer");
      const progress = vi.fn();
      const pending = runHermesUpdate(progress);
      // Attach the rejection handler before delivering the synthetic child exit.
      const settled = pending.then(
        () => "ok",
        (error) => error.message as string,
      );
      state.child?.stdout.emit(
        "data",
        Buffer.from("Fetching source changes...\n"),
      );
      expect(progress.mock.calls.length).toBeGreaterThan(0);
      for (const [event] of progress.mock.calls)
        expect(event).toMatchObject({
          operation: "update",
          step: 0,
          totalSteps: 0,
        });
      expect(
        progress.mock.calls.some(([p]) =>
          p.log.includes("Update command finished"),
        ),
      ).toBe(false);
      state.child?.emit("close", code);
      if (code === 0) expect(await settled).toBe("ok");
      else expect(await settled).toContain("Update failed (exit code 1)");
      expect(
        progress.mock.calls.some(([p]) =>
          p.log.includes("Update command finished"),
        ),
      ).toBe(code === 0);
      expect(
        progress.mock.calls.every(([p]) => p.step === 0 && p.totalSteps === 0),
      ).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  },
);
