// `npm run review -- <path>`: prints the review report as JSON on stdout.
// Progress goes to stderr so the output stays pipeable.
import { resolve } from "node:path";
import { runReview } from "../review/workflow.ts";

const scope = resolve(process.argv[2] ?? ".");
const report = await runReview(scope, console.error);
console.log(JSON.stringify(report, null, 2));
