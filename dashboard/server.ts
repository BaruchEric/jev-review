// Local-only dashboard server: static assets plus the saved review report.
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join, relative } from "node:path";
import { isReviewReport, reportPath } from "./report.ts";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 4317);
const REPORT = reportPath();

const assets: Record<string, [file: string, type: string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
};

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:",
  });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(body));
}

async function review() {
  const source = relative(process.cwd(), REPORT) || REPORT;
  let text: string;
  let savedAt: string;
  try {
    [text, savedAt] = await Promise.all([
      readFile(REPORT, "utf8"),
      stat(REPORT).then((info) => info.mtime.toISOString()),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "empty", source };
    }
    return { status: "error", source, message: "Report could not be read" };
  }

  try {
    const report = JSON.parse(text);
    if (isReviewReport(report)) return { status: "ok", source, savedAt, report };
  } catch {}
  return { status: "error", source, message: "Report is not review-code.ts output" };
}

export async function handle(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return send(res, 405, "text/plain; charset=utf-8", "Method not allowed");
  }

  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (pathname === "/api/review") return json(res, 200, await review());

  // Only the fixed asset list is served; nothing else on disk is reachable.
  const asset = assets[pathname];
  if (!asset) return send(res, 404, "text/plain; charset=utf-8", "Not found");

  const [file, type] = asset;
  send(res, 200, type, await readFile(join(import.meta.dirname, file)));
}

if (import.meta.main) {
  createServer(handle).listen(PORT, HOST, () => {
    console.log(`Jev review dashboard: http://${HOST}:${PORT}`);
    console.log(`report: ${relative(process.cwd(), REPORT) || REPORT}`);
  });
}
