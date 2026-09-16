// Orchestrates a full review of a Git scope: screen every changed source
// file, profile the riskiest few, follow the strongest signals, and assemble
// the report. Thresholds and limits are policy from the domain layer.
import { changedFiles } from "../adapters/git.ts";
import {
  CONCURRENCY,
  type Dimension,
  dimensions,
  MAX_FOLLOW_UPS,
  MAX_PROFILES,
  SCREEN_THRESHOLD,
  SEVERITY_MAX,
  TEST_FILE,
} from "../domain/config.ts";
import type { Finding, ReviewReport, Screening, Signal } from "../domain/types.ts";
import { locateSignal, profileFile, screenFile } from "./judgments.ts";

export type Log = (message: string) => void;

export async function runReview(scope: string, log: Log): Promise<ReviewReport> {
  const files = changedFiles(scope);
  if (files.length === 0) {
    throw new Error(`No changed JavaScript or TypeScript files found under ${scope}`);
  }

  const changedTests = files.filter((file) => TEST_FILE.test(file.path));
  const sourceFiles = files.filter((file) => !changedTests.includes(file));

  log(
    `Screening ${sourceFiles.length} changed source files with ${changedTests.length} changed test files as context...`,
  );
  const matrix = await mapLimit(sourceFiles, CONCURRENCY, (file) => {
    log(`  screen ${file.path}`);
    return screenFile(file, changedTests);
  });

  const signals = matrix
    .flatMap(({ file, probabilities }) =>
      (Object.entries(probabilities) as [Dimension, number][]).map(
        ([dimension, probability]): Signal => ({ file, dimension, probability }),
      ),
    )
    .filter((signal) => signal.probability >= SCREEN_THRESHOLD)
    .sort((a, b) => b.probability - a.probability);

  const profileCandidates = [...matrix]
    .sort((a, b) => maxProbability(b) - maxProbability(a))
    .slice(0, MAX_PROFILES);
  log(`Profiling ${profileCandidates.length} files...`);
  const profiles = await mapLimit(profileCandidates, CONCURRENCY, ({ file, probabilities }) => {
    log(`  profile ${file.path}`);
    return profileFile(file, probabilities);
  });

  const followUps = signals.slice(0, MAX_FOLLOW_UPS);
  log(
    `Following ${followUps.length} of ${signals.length} signals at or above ${SCREEN_THRESHOLD}...`,
  );
  const located = await mapLimit(followUps, CONCURRENCY, (signal) => {
    log(`  inspect ${signal.file.path} [${signal.dimension}=${signal.probability.toFixed(2)}]`);
    return locateSignal(signal);
  });

  const findings = located
    .filter((finding): finding is Finding => finding !== null)
    .sort((a, b) => b.severity - a.severity);

  return {
    scope,
    config: {
      screenThreshold: SCREEN_THRESHOLD,
      severityMax: SEVERITY_MAX,
      maxFollowUps: MAX_FOLLOW_UPS,
      maxProfiles: MAX_PROFILES,
    },
    screenedFiles: sourceFiles.length,
    changedTestFiles: changedTests.map((file) => file.path),
    matrix: matrix.map(({ file, probabilities }) => ({ file: file.path, ...probabilities })),
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
    findings: findings.map(({ file, ...finding }) => ({ file: file.path, ...finding })),
  };
}

function maxProbability(screening: Screening): number {
  return Math.max(...Object.values(screening.probabilities));
}

// Runs callback over items with at most `limit` in flight, preserving order.
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await callback(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
