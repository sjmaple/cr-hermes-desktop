// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import type { BrowserWindow, MessageBoxOptions } from "electron";

const mocks = vi.hoisted(() => ({
  showMessageBox: vi.fn(),
  execFile: vi.fn(),
  getConnectionConfig: vi.fn(() => ({ mode: "local" })),
  getActiveProfileNameSync: vi.fn(() => "default"),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "", setPath: vi.fn() },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock("child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("child_process")>()),
  execFile: mocks.execFile,
}));
vi.mock("../src/main/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/config")>()),
  getConnectionConfig: mocks.getConnectionConfig,
}));
vi.mock("../src/main/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/main/utils")>()),
  getActiveProfileNameSync: mocks.getActiveProfileNameSync,
}));

let root: string;
let archive: string;
let installer: typeof import("../src/main/installer");

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), "hermes-backup-consent-"));
  vi.stubEnv("HERMES_HOME", root);
  installer = await import("../src/main/installer");
  for (const path of [installer.HERMES_PYTHON, installer.HERMES_SCRIPT]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "unused fixture binary");
  }
  archive = join(root, "backup with spaces.zip");
  writeFileSync(archive, "no real archive is restored");
  writeFileSync(join(root, "config.yaml"), "model: keep-existing\n");
  mocks.getConnectionConfig.mockReturnValue({ mode: "local" });
  mocks.getActiveProfileNameSync.mockReturnValue("default");
  mocks.showMessageBox.mockResolvedValue({ response: 1 });
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    callback(null, "Import complete", "");
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("backup import consent", () => {
  // @lat: [[backup-import#Backup import#Explicit overwrite consent]]
  it("does not invoke the CLI when native confirmation is cancelled", async () => {
    mocks.showMessageBox.mockResolvedValue({ response: 0 });
    expect(await installer.runHermesImport(archive)).toEqual({
      success: false,
      error: "Backup import cancelled.",
    });
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "config.yaml"), "utf8")).toBe(
      "model: keep-existing\n",
    );
  });

  // @lat: [[backup-import#Backup import#Approved noninteractive restore]]
  it("uses the approved archive and captured named profile without stdin", async () => {
    expect(await installer.runHermesImport(archive, "work")).toEqual({
      success: true,
    });
    const options = mocks.showMessageBox.mock.calls[0][0] as MessageBoxOptions;
    expect(options).toMatchObject({
      type: "warning",
      buttons: ["Cancel", "Restore backup"],
      defaultId: 0,
      cancelId: 0,
    });
    expect(options.detail).toContain("backup with spaces.zip");
    expect(options.detail).toContain('"work"');
    expect(options.detail).toContain("outside this profile");
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      ...installer.hermesCliArgs(),
      "-p",
      "work",
      "import",
      archive,
      "--force",
    ]);
    expect(mocks.execFile.mock.calls[0][2]).toMatchObject({
      cwd: installer.HERMES_REPO,
      env: { HERMES_HOME: root },
      timeout: 120000,
    });
  });

  it("captures the active profile before waiting for consent", async () => {
    mocks.getActiveProfileNameSync.mockReturnValue("work");
    mocks.showMessageBox.mockImplementation(async () => {
      mocks.getActiveProfileNameSync.mockReturnValue("other");
      return { response: 1 };
    });
    await installer.runHermesImport(archive);
    expect(mocks.execFile.mock.calls[0][1]).toContain("work");
    expect(mocks.execFile.mock.calls[0][1]).not.toContain("other");
  });

  it("pins default explicitly even if the sticky profile changes during consent", async () => {
    mocks.showMessageBox.mockImplementation(async () => {
      mocks.getActiveProfileNameSync.mockReturnValue("other");
      writeFileSync(join(root, "active_profile"), "other");
      return { response: 1 };
    });
    await installer.runHermesImport(archive, "default");
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      ...installer.hermesCliArgs(),
      "-p",
      "default",
      "import",
      archive,
      "--force",
    ]);
  });

  it.each(["../other", "-p", "bad profile"])(
    "refuses invalid profile %s before confirmation",
    async (profile) => {
      expect((await installer.runHermesImport(archive, profile)).success).toBe(
        false,
      );
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it("parents the native warning to the live main window", async () => {
    const parent = { isDestroyed: () => false } as BrowserWindow;
    await installer.runHermesImport(archive, "default", parent);
    expect(mocks.showMessageBox.mock.calls[0][0]).toBe(parent);
  });

  it("does not prompt or start a child for a missing archive or installation", async () => {
    expect(
      (await installer.runHermesImport(join(root, "missing.zip"))).success,
    ).toBe(false);
    rmSync(installer.HERMES_PYTHON);
    expect(await installer.runHermesImport(archive)).toEqual({
      success: false,
      error: "Hermes is not installed.",
    });
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  // @lat: [[backup-import#Backup import#Local target isolation]]
  it.each(["ssh", "remote"])(
    "refuses %s instead of restoring local data",
    async (mode) => {
      mocks.getConnectionConfig.mockReturnValue({ mode });
      expect((await installer.runHermesImport(archive)).success).toBe(false);
      expect(mocks.showMessageBox).not.toHaveBeenCalled();
      expect(mocks.execFile).not.toHaveBeenCalled();
    },
  );

  it("refuses a connection switch during confirmation", async () => {
    mocks.showMessageBox.mockImplementation(async () => {
      mocks.getConnectionConfig.mockReturnValue({ mode: "remote" });
      return { response: 1 };
    });
    expect((await installer.runHermesImport(archive)).success).toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  // @lat: [[backup-import#Backup import#CLI failure diagnostics]]
  it("preserves an upstream stdout error when stderr is empty", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
      callback(
        new Error("Command failed"),
        "\u001b[31mError: Invalid archive\u001b[0m\n",
        "",
      );
    });
    expect(await installer.runHermesImport(archive)).toEqual({
      success: false,
      error: "Error: Invalid archive\n",
    });
  });

  it("fails without invoking the CLI if the dialog cannot be shown", async () => {
    mocks.showMessageBox.mockRejectedValue(new Error("window gone"));
    expect((await installer.runHermesImport(archive)).success).toBe(false);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
