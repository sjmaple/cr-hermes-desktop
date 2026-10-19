import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const i18nState = vi.hoisted(() => ({
  t: (key: string): string => `en:${key}`,
}));

vi.mock("../../components/useI18n", () => ({
  useI18n: () => ({ t: i18nState.t }),
}));

import Install from "./Install";

describe("Install", () => {
  beforeEach(() => {
    i18nState.t = (key: string): string => `en:${key}`;
  });

  // @lat: [[onboarding#Install confirm + progress#Single-run installation]]
  it("does not restart an active installation when translations change", async () => {
    let resolveInstall!: (result: { success: boolean; error?: string }) => void;
    const startInstall = vi.fn(
      () =>
        new Promise<{ success: boolean; error?: string }>((resolve) => {
          resolveInstall = resolve;
        }),
    );
    const removeProgressListener = vi.fn();

    Object.defineProperty(window, "hermesAPI", {
      configurable: true,
      value: {
        inspectInstallTarget: vi.fn().mockResolvedValue({
          hermesHome: "/tmp/hermes",
          repoPath: "/tmp/hermes/hermes-agent",
          state: "fresh",
        }),
        onInstallProgress: vi.fn(() => removeProgressListener),
        startInstall,
      },
    });

    const props = {
      onComplete: vi.fn(),
      onFailed: vi.fn(),
      onCancel: vi.fn(),
    };
    const view = render(<Install {...props} />);

    fireEvent.click(screen.getByText("en:install.confirmInstallBtn"));
    await waitFor(() => expect(startInstall).toHaveBeenCalledTimes(1));

    i18nState.t = (key: string): string => `fr:${key}`;
    view.rerender(<Install {...props} />);

    expect(startInstall).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveInstall({ success: false });
      await Promise.resolve();
    });

    expect(startInstall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("fr:install.retryInstallation"));
    expect(props.onFailed).toHaveBeenCalledWith(
      "fr:install.installationFailedHint",
    );
  });
  // @lat: [[desktop-updates#Agent phases#Running phase is indeterminate]]
  it.each([
    [1, 1],
    [7, 7],
  ])(
    "does not label a running phase %i/%i as 100 percent",
    async (step, totalSteps) => {
      let progress:
        | ((p: {
            step: number;
            totalSteps: number;
            title: string;
            detail: string;
            log: string;
          }) => void)
        | undefined;
      let finish: ((result: { success: boolean }) => void) | undefined;
      Object.defineProperty(window, "hermesAPI", {
        configurable: true,
        value: {
          inspectInstallTarget: vi.fn(async () => ({
            hermesHome: "/isolated/home",
            repoPath: "/isolated/agent",
            state: "update",
          })),
          onInstallProgress: vi.fn((cb) => {
            progress = cb;
            return vi.fn();
          }),
          startInstall: vi.fn(
            () =>
              new Promise((resolve) => {
                finish = resolve;
              }),
          ),
        },
      });
      render(
        <Install onComplete={vi.fn()} onFailed={vi.fn()} onCancel={vi.fn()} />,
      );
      fireEvent.click(screen.getByText("en:install.confirmInstallBtn"));
      await waitFor(() =>
        expect(window.hermesAPI.startInstall).toHaveBeenCalledOnce(),
      );
      act(() =>
        progress?.({
          step,
          totalSteps,
          title: "Updating Agent",
          detail: "Subprocess still running",
          log: "running\n",
        }),
      );
      expect(screen.queryByText("100%")).not.toBeInTheDocument();
      expect(screen.getByRole("progressbar")).not.toHaveAttribute(
        "aria-valuenow",
      );
      expect(screen.getByText("Subprocess still running")).toBeInTheDocument();
      await act(async () => {
        finish?.({ success: true });
      });
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "100",
      );
    },
  );
});
