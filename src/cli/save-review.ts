// `npm run review:save -- <path>`: runs the review and saves the report for
// the dashboard. The previous report is only replaced when the review
// completes; a failure leaves it untouched.
import { relative, resolve } from "node:path";
import { reportPath, saveReport } from "../adapters/report-store.ts";
import { runReview } from "../review/workflow.ts";

const scope = resolve(process.argv[2] ?? ".");
const out = reportPath();
const outLabel = relative(process.cwd(), out) || out;

try {
  const report = await runReview(scope, console.error);
  await saveReport(report, out);
  console.error(`saved ${outLabel}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`review failed; ${outLabel} unchanged`);
  process.exit(1);
}
