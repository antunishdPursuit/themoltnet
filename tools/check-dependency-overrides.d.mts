// Types for the plain-JavaScript tool script, so its tests are type-checked.

/** An advisory as reported by `pnpm audit --json`. */
export interface AuditAdvisory {
  id?: number;
  github_advisory_id?: string;
  module_name: string;
  severity: string;
  title: string;
}

export interface AuditReport {
  advisories?: Record<string, AuditAdvisory>;
}

export interface DevOnlyAdvisory {
  id: string;
  severity: string;
  title: string;
}

export function overrideTarget(key: string): string;

export function devOnlyAdvisories(
  target: string,
  prodReport: AuditReport,
  fullReport: AuditReport,
): DevOnlyAdvisory[];
