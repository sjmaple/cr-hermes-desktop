import { describe, expect, it, vi } from "vitest";
import { initializeSystemCertificateTrust } from "./system-ca-trust";

describe("main-process system certificate trust", () => {
  // @lat: [[remote-dashboard-oauth#Test specifications#Certificate defaults are preserved]]
  it("extends the existing bundled/extra/custom selection instead of replacing it", () => {
    const existing = ["bundled", "extra", "existing-custom"];
    const getCACertificates = vi.fn((type: "default" | "system") =>
      type === "default" ? existing : ["trusted-system", "bundled"],
    );
    const setDefaultCACertificates = vi.fn();
    expect(
      initializeSystemCertificateTrust({
        getCACertificates,
        setDefaultCACertificates,
      }),
    ).toBe("enabled");
    expect(setDefaultCACertificates).toHaveBeenCalledExactlyOnceWith([
      "bundled",
      "extra",
      "existing-custom",
      "trusted-system",
    ]);
    expect(existing).toEqual(["bundled", "extra", "existing-custom"]);
  });

  // @lat: [[remote-dashboard-oauth#Test specifications#Unsupported TLS runtimes keep defaults]]
  it.each([
    {},
    { getCACertificates: vi.fn() },
    { setDefaultCACertificates: vi.fn() },
  ])("requires both supported APIs before changing trust", (api) => {
    expect(initializeSystemCertificateTrust(api)).toBe("unsupported");
    for (const method of Object.values(api))
      expect(method).not.toHaveBeenCalled();
  });

  // @lat: [[remote-dashboard-oauth#Test specifications#System trust lookup failures remain verified]]
  it("leaves existing verification untouched when system lookup fails", () => {
    const setDefaultCACertificates = vi.fn();
    expect(
      initializeSystemCertificateTrust({
        getCACertificates: (type) => {
          if (type === "system") throw new Error("system store unavailable");
          return ["existing"];
        },
        setDefaultCACertificates,
      }),
    ).toBe("unavailable");
    expect(setDefaultCACertificates).not.toHaveBeenCalled();
  });

  // @lat: [[remote-dashboard-oauth#Test specifications#Invalid system roots keep verification]]
  it("returns unavailable when the runtime refuses the provided CA set", () => {
    expect(
      initializeSystemCertificateTrust({
        getCACertificates: () => ["invalid"],
        setDefaultCACertificates: () => {
          throw new Error("invalid PEM");
        },
      }),
    ).toBe("unavailable");
  });
});
