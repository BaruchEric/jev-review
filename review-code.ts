import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";

const SCREEN_THRESHOLD = 0.7;
const MAX_FOLLOW_UPS = 8;
const MAX_PROFILES = 5;
const CONCURRENCY = 3;
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;

const dimensions = {
  correctness: "The change likely introduces incorrect runtime behavior.",
  security: "The change introduces or weakens a security boundary.",
  reliability: "The change can cause a crash, race, leak, deadlock, or poor failure recovery.",
  compatibility: "The change can break an existing caller, persisted format, or public behavior.",
  testGap: "Important changed behavior lacks adequate targeted test evidence in this patch.",
} as const;

const mechanisms = {
  correctness: {
    condition: "A condition handles the wrong cases",
    state: "State is read, updated, or retained incorrectly",
    dataFlow: "Data is transformed or passed incorrectly",
    asyncControl: "Asynchronous ordering or error handling is incorrect",
    other: "Another concrete correctness mechanism",
    noIssue: "The selected hunk does not support a concrete correctness issue",
  },
  security: {
    authorization: "Authorization or trust boundaries are weakened",
    injection: "Untrusted input can reach an unsafe interpreter or sink",
    exposure: "Sensitive data can be disclosed",
    unsafeDefault: "A default configuration creates avoidable exposure",
    other: "Another concrete security mechanism",
    noIssue: "The selected hunk does not support a concrete security issue",
  },
  reliability: {
    cleanup: "A resource or side effect is not cleaned up",
    concurrency: "Concurrency can race, deadlock, or lose work",
    recovery: "Failure or cancellation recovery is incomplete",
    crash: "A realistic path can throw or terminate unexpectedly",
    other: "Another concrete reliability mechanism",
    noIssue: "The selected hunk does not support a concrete reliability issue",
  },
  compatibility: {
    api: "A public API or type contract changes incompatibly",
    behavior: "Existing callers observe changed behavior",
    dataFormat: "A persisted or exchanged format changes incompatibly",
    protocol: "An external command or protocol contract changes",
    other: "Another concrete compatibility mechanism",
    noIssue: "The selected hunk does not support a concrete compatibility issue",
  },
  testGap: {
    branch: "An important branch lacks targeted coverage",
    failure: "A failure or cancellation path lacks coverage",
    boundary: "A boundary or edge case lacks coverage",
    integration: "An interaction between components lacks coverage",
    other: "Another concrete test gap",
    noIssue: "The selected hunk does not support a concrete test gap",
  },
} as const;

type Dimension = keyof typeof dimensions;

type ChangedFile = {
  path: string;
  patch: string;
};

type Hunk = {
  id: string;
  startLine: number;
  patch: string;
};

type Signal = {
  file: ChangedFile;
  dimension: Dimension;
  probability: number;
};

type Finding = Signal & {
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

type FileProfile = {
  file: string;
  changeType: string;
  changeTypeConfidence: number;
  reviewPriority: number;
  reviewPriorityConfidence: number;
};

const client = new TypeSafeClient();

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}

function changedFiles(scope: string): ChangedFile[] {
  const repoRoot = git(scope, ["rev-parse", "--show-toplevel"]).trim();
  const relativeScope = relative(repoRoot, scope) || ".";

  const tracked = git(repoRoot, [
    "diff",
    "HEAD",
    "--name-only",
    "--diff-filter=ACMRTUXB",
    "--",
    relativeScope,
  ])
    .split("\n")
    .filter(Boolean);

  const untracked = git(repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    relativeScope,
  ])
    .split("\n")
    .filter(Boolean);

  const untrackedSet = new Set(untracked);
  const paths = [...new Set([...tracked, ...untracked])].filter((path) =>
    SOURCE_FILE.test(path),
  );

  return paths.map((path) => {
    if (untrackedSet.has(path)) {
      const source = readFileSync(resolve(repoRoot, path), "utf8");
      const lines = source.split("\n");
      const chunks = Array.from(
        { length: Math.ceil(lines.length / 80) },
        (_, index) => {
          const start = index * 80;
          const chunk = lines.slice(start, start + 80);
          return [
            `@@ -0,0 +${start + 1},${chunk.length} @@`,
            ...chunk.map((line) => `+${line}`),
          ].join("\n");
        },
      );
      return {
        path,
        patch: chunks.join("\n"),
      };
    }

    return {
      path,
      patch: git(repoRoot, [
        "diff",
        "HEAD",
        "--unified=3",
        "--",
        path,
      ]),
    };
  });
}

function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: string[] | null = null;
  let startLine = 1;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) {
      if (current) {
        hunks.push({
          id: `hunk_${hunks.length + 1}`,
          startLine,
          patch: current.join("\n"),
        });
      }

      const match = line.match(/\+(\d+)/);
      startLine = match ? Number(match[1]) : 1;
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }

  if (current) {
    hunks.push({
      id: `hunk_${hunks.length + 1}`,
      startLine,
      patch: current.join("\n"),
    });
  }

  return hunks;
}

async function screenFile(file: ChangedFile, changedTests: ChangedFile[]) {
  const response = await client.systemOne({
    state: { file, changedTests },
    questions: {
      correctness: noul(
        "Does file.patch provide evidence that the change likely introduces incorrect runtime behavior?",
      ),
      security: noul(
        "Does file.patch provide evidence that the change introduces or weakens a security boundary?",
      ),
      reliability: noul(
        "Does file.patch provide evidence that the change can cause a crash, race, leak, deadlock, or poor failure recovery?",
      ),
      compatibility: noul(
        "Does file.patch provide evidence that the change can break an existing caller, persisted format, or public behavior?",
      ),
      testGap: noul(
        "Does file.patch change important behavior without adequate targeted test evidence in changedTests?",
      ),
    },
  });

  return {
    file,
    probabilities: {
      correctness: response.answers.correctness.noul,
      security: response.answers.security.noul,
      reliability: response.answers.reliability.noul,
      compatibility: response.answers.compatibility.noul,
      testGap: response.answers.testGap.noul,
    },
  };
}

async function profileFile(
  file: ChangedFile,
  screeningProbabilities: Record<Dimension, number>,
): Promise<FileProfile> {
  const response = await client.systemOne({
    state: { file, screeningProbabilities },
    questions: {
      changeType: choice(
        "Which kind of change best describes file.patch?",
        {
          behavior: "Adds or changes runtime behavior",
          interface: "Changes an exported API, type, protocol, or data shape",
          infrastructure: "Changes execution, scheduling, build, or operational plumbing",
          observability: "Changes events, logging, monitoring, or diagnostics",
          refactor: "Restructures implementation without intending behavior changes",
          routine: "A small routine change that fits none of the other categories",
        },
      ),
      reviewPriority: score(
        "Rate how closely a human should review file.patch, considering the code and screeningProbabilities.",
        [
          "Routine review is sufficient",
          "A focused review of the changed behavior is useful",
          "Careful review is needed before merge",
          "Specialist or immediate review is needed",
        ],
      ),
    },
  });

  return {
    file: file.path,
    changeType: response.answers.changeType.choice,
    changeTypeConfidence: response.answers.changeType.confidence,
    reviewPriority: response.answers.reviewPriority.score,
    reviewPriorityConfidence: response.answers.reviewPriority.confidence,
  };
}

async function locateSignal(signal: Signal): Promise<Finding | null> {
  const hunks = parseHunks(signal.file.patch);
  if (hunks.length === 0) return null;

  const location = await client.systemOne({
    state: {
      file: signal.file.path,
      suspectedConcern: {
        dimension: signal.dimension,
        definition: dimensions[signal.dimension],
        screeningProbability: signal.probability,
      },
      candidateHunks: hunks,
    },
    questions: {
      evidence: choice(
        "Which candidate hunk provides the strongest direct evidence for suspectedConcern? Select noMatch when no hunk provides sufficient evidence.",
        {
          ...Object.fromEntries(
            hunks.map((hunk) => [
              hunk.id,
              `The candidate beginning at changed-file line ${hunk.startLine}`,
            ]),
          ),
          noMatch: "No candidate hunk directly supports the suspected concern",
        },
      ),
    },
  });

  const selected = location.answers.evidence;
  if (selected.choice === "noMatch" || selected.confidence < 0.55) {
    return null;
  }

  const hunk = hunks.find((candidate) => candidate.id === selected.choice);
  if (!hunk) return null;

  const classification = await client.systemOne({
    state: {
      file: signal.file.path,
      suspectedConcern: {
        dimension: signal.dimension,
        definition: dimensions[signal.dimension],
      },
      selectedHunk: hunk,
    },
    questions: {
      mechanism: choice(
        "Which mechanism best describes the suspected concern supported by selectedHunk?",
        mechanisms[signal.dimension],
      ),
    },
  });

  const mechanism = classification.answers.mechanism;
  if (mechanism.choice === "noIssue") return null;

  const impact = await client.systemOne({
    state: {
      file: signal.file.path,
      suspectedConcern: {
        dimension: signal.dimension,
        definition: dimensions[signal.dimension],
      },
      selectedHunk: hunk,
    },
    questions: {
      severity: score(
        "Assuming selectedHunk exhibits suspectedConcern, rate the likely impact if the changed code is used in production.",
        [
          "No meaningful impact or no supported issue",
          "Minor or narrowly limited impact",
          "Significant correctness, reliability, compatibility, or security impact",
          "Critical security, data-loss, or widespread outage impact",
        ],
      ),
    },
  });

  const severity = impact.answers.severity;
  let owner: string | null = null;
  let ownerConfidence: number | null = null;

  if (severity.score >= 1.5) {
    const routing = await client.systemOne({
      state: {
        file: signal.file.path,
        concern: {
          dimension: signal.dimension,
          mechanism: mechanism.choice,
          severity: severity.score,
        },
        selectedHunk: hunk,
      },
      questions: {
        owner: choice(
          "Which reviewer is best suited to investigate this concern?",
          {
            security: "Security, authentication, authorization, or data exposure",
            api: "Public APIs, compatibility, schemas, or protocols",
            runtime: "Execution, concurrency, resources, or failure recovery",
            testing: "Coverage strategy, fixtures, or regression testing",
            maintainer: "The owning domain or feature maintainer",
          },
        ),
      },
    });
    owner = routing.answers.owner.choice;
    ownerConfidence = routing.answers.owner.confidence;
  }

  return {
    ...signal,
    line: hunk.startLine,
    locationConfidence: selected.confidence,
    mechanism: mechanism.choice,
    mechanismConfidence: mechanism.confidence,
    severity: severity.score,
    severityConfidence: severity.confidence,
    owner,
    ownerConfidence,
    action: severity.score >= 2 ? "request_changes" : "comment",
  };
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker(),
    ),
  );

  return results;
}

async function main() {
  const scope = resolve(process.argv[2] ?? ".");
  const files = changedFiles(scope);

  if (files.length === 0) {
    throw new Error(`No changed JavaScript or TypeScript files found under ${scope}`);
  }

  const changedTests = files.filter((file) =>
    /(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(file.path),
  );
  const sourceFiles = files.filter((file) => !changedTests.includes(file));

  console.error(
    `Screening ${sourceFiles.length} changed source files with ${changedTests.length} changed test files as context...`,
  );
  const matrix = await mapLimit(sourceFiles, CONCURRENCY, async (file) => {
    console.error(`  screen ${file.path}`);
    return screenFile(file, changedTests);
  });

  const signals = matrix
    .flatMap(({ file, probabilities }) =>
      (Object.entries(probabilities) as [Dimension, number][]).map(
        ([dimension, probability]) => ({ file, dimension, probability }),
      ),
    )
    .filter((signal) => signal.probability >= SCREEN_THRESHOLD)
    .sort((a, b) => b.probability - a.probability);

  const profileCandidates = [...matrix]
    .sort(
      (a, b) =>
        Math.max(...Object.values(b.probabilities)) -
        Math.max(...Object.values(a.probabilities)),
    )
    .slice(0, MAX_PROFILES);
  console.error(`Profiling ${profileCandidates.length} files...`);
  const profiles = await mapLimit(
    profileCandidates,
    CONCURRENCY,
    async ({ file, probabilities }) => {
      console.error(`  profile ${file.path}`);
      return profileFile(file, probabilities);
    },
  );

  const followUps = signals.slice(0, MAX_FOLLOW_UPS);
  console.error(
    `Following ${followUps.length} of ${signals.length} signals at or above ${SCREEN_THRESHOLD}...`,
  );

  const located = await mapLimit(followUps, CONCURRENCY, async (signal) => {
    console.error(
      `  inspect ${signal.file.path} [${signal.dimension}=${signal.probability.toFixed(2)}]`,
    );
    return locateSignal(signal);
  });

  const findings = located
    .filter((finding): finding is Finding => finding !== null)
    .sort((a, b) => b.severity - a.severity);

  console.log(
    JSON.stringify(
      {
        scope,
        config: {
          screenThreshold: SCREEN_THRESHOLD,
          severityMax: 3,
          maxFollowUps: MAX_FOLLOW_UPS,
          maxProfiles: MAX_PROFILES,
        },
        screenedFiles: sourceFiles.length,
        changedTestFiles: changedTests.map((file) => file.path),
        matrix: matrix.map(({ file, probabilities }) => ({
          file: file.path,
          ...probabilities,
        })),
        followedSignals: followUps.length,
        profiles,
        workflow: {
          screenedCells: sourceFiles.length * Object.keys(dimensions).length,
          thresholdSignals: signals.length,
          profiledFiles: profiles.length,
          followedSignals: followUps.length,
          locatedFindings: findings.length,
          routedFindings: findings.filter((finding) => finding.owner !== null).length,
        },
        findings: findings.map(({ file, ...finding }) => ({
          file: file.path,
          ...finding,
        })),
      },
      null,
      2,
    ),
  );
}

await main();
