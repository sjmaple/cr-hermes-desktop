import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import https from "https";
import {
  PROVIDERS,
  providerRouteForEnvKey,
} from "../src/renderer/src/constants";
import Setup from "../src/renderer/src/screens/Setup/Setup";

vi.mock("../src/renderer/src/components/useI18n", () => ({
  useI18n: () => ({ t: (key: string): string => key }),
}));
vi.mock("../src/renderer/src/components/common/BrandLogo", () => ({
  default: (): React.JSX.Element => createElement("span"),
}));
vi.mock("../src/renderer/src/components/VerifyWarningBanner", () => ({
  default: (): React.JSX.Element => createElement("span"),
}));

let home: string;
beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "hermes-opencode-setup-"));
  vi.stubEnv("HERMES_HOME", home);
  mkdirSync(join(home, "profiles/work"), { recursive: true });
  for (const folder of [home, join(home, "profiles/work")]) {
    writeFileSync(join(folder, ".env"), "UNRELATED_API_KEY=fixture-other\n");
    writeFileSync(
      join(folder, "config.yaml"),
      'model:\n  provider: "openai-codex"\n  default: "old-model"\n  base_url: "https://old-provider.test/v1"\n',
    );
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  rmSync(home, { recursive: true, force: true });
});

const providers = [
  {
    id: "opencode-zen",
    name: "OpenCode Zen",
    key: "OPENCODE_ZEN_API_KEY",
    url: "https://opencode.ai/zen/v1",
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    key: "OPENCODE_GO_API_KEY",
    url: "https://opencode.ai/zen/go/v1",
  },
];

// @lat: [[provider-setup#Provider setup#OpenCode Zen and Go#Profile-scoped setup and selection]]
it.each(
  providers.flatMap((provider) =>
    ["default", "work"].map((profile) => ({ ...provider, profile })),
  ),
)(
  "actual $name setup writes only $profile credentials and native routing, retaining a user-selected model",
  async ({ id, name, key, url, profile }) => {
    const config = await import("../src/main/config");
    const { expectedEnvKeyForModel } = await import("../src/main/installer");
    const setEnv = vi.fn(
      async (
        envKey: string,
        value: string,
        target?: string,
      ): Promise<boolean> => {
        config.setEnvValue(envKey, value, target);
        return true;
      },
    );
    const setModelConfig = vi.fn(
      async (
        provider: string,
        model: string,
        baseUrl: string,
        target?: string,
      ): Promise<boolean> => {
        config.setModelConfig(provider, model, baseUrl, target);
        return true;
      },
    );
    const api = { setEnv, setModelConfig, openExternal: vi.fn() };
    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: api,
    });
    const target = profile === "default" ? home : join(home, "profiles/work");
    const other = profile === "default" ? join(home, "profiles/work") : home;
    const untouchedConfig = readFileSync(join(other, "config.yaml"), "utf8");
    const untouchedEnv = readFileSync(join(other, ".env"), "utf8");
    const onComplete = vi.fn();
    render(createElement(Setup, { profile, onComplete }));
    expect(PROVIDERS.options).toContainEqual({ value: id, label: name });
    fireEvent.click(screen.getByRole("button", { name }));
    fireEvent.change(screen.getByPlaceholderText("sk-..."), {
      target: { value: "fixture-key" },
    });
    fireEvent.click(screen.getByText("setup.noKeyHint"));
    expect(api.openExternal).toHaveBeenCalledWith("https://opencode.ai/auth");
    fireEvent.click(screen.getByText("setup.continue"));
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(setEnv).toHaveBeenCalledExactlyOnceWith(key, "fixture-key", profile);
    expect(setModelConfig).toHaveBeenCalledExactlyOnceWith(id, "", "", profile);
    expect(config.readEnv(profile)).toEqual({
      UNRELATED_API_KEY: "fixture-other",
      [key]: "fixture-key",
    });
    expect(config.getModelConfig(profile)).toMatchObject({
      provider: id,
      model: "",
      baseUrl: url,
    });
    expect(expectedEnvKeyForModel(id, url)).toBe(key);
    expect(providerRouteForEnvKey(key)).toEqual({ provider: id, baseUrl: "" });
    expect(readFileSync(join(target, "config.yaml"), "utf8")).not.toContain(
      "old-provider.test",
    );
    // A subsequent explicit model choice retains its raw native provider and URL.
    await setModelConfig(id, "user-selected-model", "", profile);
    expect(config.getModelConfig(profile)).toMatchObject({
      provider: id,
      model: "user-selected-model",
      baseUrl: url,
    });
    expect(readFileSync(join(other, "config.yaml"), "utf8")).toBe(
      untouchedConfig,
    );
    expect(readFileSync(join(other, ".env"), "utf8")).toBe(untouchedEnv);
  },
);

// @lat: [[provider-setup#Provider setup#OpenCode Zen and Go#Unrelated keys cannot authenticate OpenCode]]
it.each(
  providers.flatMap((provider) =>
    ["default", "work"].map((profile) => ({ ...provider, profile })),
  ),
)(
  "$name discovery does not borrow another profile or an unrelated key for $profile",
  async ({ id, key, profile }) => {
    const other = profile === "default" ? join(home, "profiles/work") : home;
    writeFileSync(join(other, ".env"), `${key}=fixture-other-profile\n`);
    const { discoverProviderModels } =
      await import("../src/main/model-discovery");
    const requests = vi.spyOn(https, "request").mockImplementation(() => {
      throw new Error("Credential-less discovery must not contact a provider");
    });
    await expect(
      discoverProviderModels(id, undefined, undefined, profile),
    ).resolves.toEqual({ models: [], status: "no-key", cached: false });
    expect(requests).not.toHaveBeenCalled();
  },
);
