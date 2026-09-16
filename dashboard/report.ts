import { resolve } from "node:path";

// Where the dashboard reads (and review:save writes) the latest review output.
// Override with REVIEW_FILE=path/to/review.json.
export function reportPath(): string {
  return process.env.REVIEW_FILE
    ? resolve(process.env.REVIEW_FILE)
    : resolve(import.meta.dirname, "..", "reviews", "latest.json");
}

// Loose structural check of the JSON printed by review-code.ts.
export function isReviewReport(value: unknown): boolean {
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
