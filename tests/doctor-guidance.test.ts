import { describe, expect, test } from "bun:test";
import { formatDoctorReport, withRecoveryGuidance } from "../src/doctor";

describe("doctor recovery guidance", () => {
  test("unreachable runtime advice preserves active tasks and requires verification", () => {
    const check = withRecoveryGuidance({ id: "proxy", status: "error", message: "unreachable" });
    expect(check.nextStep).toContain("ownership");
    expect(check.nextStep).toContain("active");
    expect(check.nextStep).toContain("rerun doctor");
    const report = { ok: false, checks: [check] };
    expect(JSON.parse(JSON.stringify(report)).checks[0].nextStep).toBe(check.nextStep);
    expect(formatDoctorReport(report)).toContain(`Next: ${check.nextStep}`);
    expect(formatDoctorReport(report)).toContain("not ready");
  });

  test("healthy checks and intentional tool-free mode do not suggest repair", () => {
    expect(withRecoveryGuidance({ id: "proxy", status: "ok", message: "healthy" }).nextStep).toBeUndefined();
    expect(withRecoveryGuidance({ id: "tools", status: "warning", message: "browser-only" }).nextStep).toBeUndefined();
  });

  test("connector verification stays distinct from local readiness", () => {
    const check = withRecoveryGuidance({ id: "connector", status: "warning", message: "unverified" });
    expect(check.status).toBe("warning");
    expect(check.nextStep).toContain("perform a tool call");
  });
});
