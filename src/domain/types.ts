// Shapes that flow through the review workflow and into the saved report.
import type { Dimension } from "./config.ts";

export type ChangedFile = {
  path: string;
  patch: string;
};

export type Hunk = {
  id: string;
  startLine: number;
  patch: string;
};

// One row of the screening matrix: every dimension scored for one file.
export type Screening = {
  file: ChangedFile;
  probabilities: Record<Dimension, number>;
};

// One matrix cell that crossed the screening threshold.
export type Signal = {
  file: ChangedFile;
  dimension: Dimension;
  probability: number;
};

export type Finding = Signal & {
  line: number;
  locationConfidence: number;
  mechanism: string;
  mechanismConfidence: number;
  severity: number;
  severityConfidence: number;
  owner: string | null;
  ownerConfidence: number | null;
  action: "comment" | "request_changes";
};

export type FileProfile = {
  file: string;
  changeType: string;
  changeTypeConfidence: number;
  reviewPriority: number;
  reviewPriorityConfidence: number;
};

// The JSON document printed by the CLI, saved by review:save, and read by
// the dashboard. Findings are flattened to file paths here.
export type ReviewReport = {
  scope: string;
  config: {
    screenThreshold: number;
    severityMax: number;
    maxFollowUps: number;
    maxProfiles: number;
  };
  screenedFiles: number;
  changedTestFiles: string[];
  matrix: Array<{ file: string } & Record<Dimension, number>>;
  followedSignals: number;
  profiles: FileProfile[];
  workflow: {
    screenedCells: number;
    thresholdSignals: number;
    profiledFiles: number;
    followedSignals: number;
    locatedFindings: number;
    routedFindings: number;
  };
  findings: Array<Omit<Finding, "file"> & { file: string }>;
};

// Loose structural check for JSON read back from disk or a child process.
export function isReviewReport(value: unknown): value is ReviewReport {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const report = value as Record<string, unknown>;
  return (
    typeof report.scope === "string" &&
    typeof report.screenedFiles === "number" &&
    Array.isArray(report.changedTestFiles) &&
    Array.isArray(report.matrix) &&
    typeof report.followedSignals === "number" &&
    Array.isArray(report.findings)
  );
}
