import type { SourceReport } from "../protocol/schema";

/** Readings of the NAS demo, step 0..11 (oldest first), per scene. */
export function demoNasReport(scene: string | null, step: number): SourceReport {
  const wave = (base: number, amp: number, phase: number): number => Math.round(base + amp * Math.sin(step * 0.7 + phase));
  const critical = scene === "critical";
  const warn = scene === "warn";
  const cpu = critical ? Math.min(99, 70 + step * 3) : warn ? wave(76, 8, 0) : wave(34, 14, 0);
  const gpu = wave(critical ? 70 : 46, 18, 1.3);
  const ram = warn || critical ? Math.min(96, 78 + Math.round(step * 1.2)) : wave(52, 5, 2.2);
  return {
    name: "NAS",
    metrics: [
      { id: "cpu", label: "CPU", value: cpu, unit: "%", warn: 80, critical: 95 },
      { id: "gpu", label: "GPU", value: gpu, unit: "%", warn: 90, critical: 98 },
      { id: "ram", label: "RAM", value: ram, unit: "%", warn: 85, critical: 95 },
      { id: "web", label: "Web", state: "ok" },
    ],
  };
}
