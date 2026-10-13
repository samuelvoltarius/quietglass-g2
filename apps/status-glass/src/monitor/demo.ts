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

export interface DemoMachine {
  readonly id: string;
  readonly name: string;
  /** Base CPU load and RAM use of the demo machine. */
  readonly cpu: number;
  readonly ram: number;
  /** More than 0: the machine has been unreachable for this many minutes. */
  readonly offlineMinutes: number;
}

/** Four machines for `?demo=1&scene=fleet`: fine, warning, critical, offline. */
export const DEMO_FLEET: readonly DemoMachine[] = [
  { id: "spark", name: "Spark", cpu: 22, ram: 48, offlineMinutes: 0 },
  { id: "pi5", name: "Pi5", cpu: 55, ram: 88, offlineMinutes: 0 },
  { id: "ns1", name: "ns1", cpu: 90, ram: 70, offlineMinutes: 0 },
  { id: "samuel", name: "samuel", cpu: 35, ram: 40, offlineMinutes: 12 },
];

export function demoFleetReport(machine: DemoMachine, step: number): SourceReport {
  const wave = (base: number, amp: number, phase: number): number => Math.min(99, Math.max(1, Math.round(base + amp * Math.sin(step * 0.8 + phase))));
  return {
    name: machine.name,
    metrics: [
      { id: "load", label: "Load", value: wave(machine.cpu, 8, 0), unit: "%", warn: 70, critical: 85 },
      { id: "memory", label: "RAM", value: wave(machine.ram, 3, 1), unit: "%", warn: 85, critical: 95 },
    ],
  };
}
