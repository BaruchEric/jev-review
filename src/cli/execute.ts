import { relative, resolve } from "node:path";
import { reportPath, saveReport } from "../adapters/report-store.ts";
import type { JevUsage, ReviewReport } from "../domain/types.ts";
import type { Log } from "../review/workflow.ts";

type Runner = (scope: string, log: Log) => Promise<ReviewReport>;

/** One line for the terminal: how much Jev work the review took and what it cost. */
export function usageLine(usage: JevUsage): string {
  const n = (value: number) => value.toLocaleString("en-US");
  const cost = usage.costUsd === null ? "cost not reported on this route" : "$" + usage.costUsd.toFixed(4);
  const model = usage.model ? usage.model + " via " + usage.route : usage.route;
  return (
    "Jev: " + n(usage.calls) + " calls, " + n(usage.inputTokens) + " in / " + n(usage.outputTokens) +
    " out tokens, " + cost + ", " + (usage.latencyMs / 1000).toFixed(1) + "s in model calls (" + model + ")"
  );
}

export async function printReview(run: Runner): Promise<void> {
  const scope = resolve(process.argv[2] ?? ".");
  const report = await run(scope, console.error);
  console.error(usageLine(report.usage));
  console.log(JSON.stringify(report, null, 2));
}

export async function saveReview(run: Runner): Promise<void> {
  const scope = resolve(process.argv[2] ?? ".");
  const out = reportPath();
  const outLabel = relative(process.cwd(), out) || out;

  try {
    const report = await run(scope, console.error);
    await saveReport(report, out);
    console.error(usageLine(report.usage));
    console.error("saved " + outLabel);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("review failed; " + outLabel + " unchanged");
    process.exit(1);
  }
}
