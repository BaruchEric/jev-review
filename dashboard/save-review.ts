// Runs review-code.ts unchanged, passing through its arguments and progress
// output, and saves its JSON result for the dashboard. The previous report is
// only replaced when the review succeeds and prints a valid report.
import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isReviewReport, reportPath } from "./report.ts";

const reviewer = resolve(import.meta.dirname, "..", "review-code.ts");
const out = reportPath();

const child = spawn(process.execPath, [reviewer, ...process.argv.slice(2)], {
  stdio: ["ignore", "pipe", "inherit"],
});

const chunks: Buffer[] = [];
child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

const code = await new Promise<number | null>((done, fail) => {
  child.on("error", fail);
  child.on("close", done);
});

function stop(message: string, exitCode = 1): never {
  console.error(`${message}; ${relative(process.cwd(), out)} unchanged`);
  process.exit(exitCode);
}

if (code !== 0) stop(`review exited with code ${code}`, code ?? 1);

let report: unknown;
try {
  report = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  stop("review output was not JSON");
}
if (!isReviewReport(report)) stop("review output did not match the expected shape");

await mkdir(dirname(out), { recursive: true });
const temp = `${out}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`);
await rename(temp, out);
console.error(`saved ${relative(process.cwd(), out)}`);
