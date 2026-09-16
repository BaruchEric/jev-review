// Every model call the reviewer makes, one bounded judgment per function.
// Policy (thresholds, rubrics, vocab) comes from the domain layer.
import { choice, noul, score, TypeSafeClient } from "@typesafe-ai/sdk";
import {
  BLOCKING_SEVERITY,
  changeTypes,
  type Dimension,
  dimensions,
  mechanisms,
  MIN_LOCATION_CONFIDENCE,
  owners,
  reviewPriorityRubric,
  ROUTE_SEVERITY,
  severityRubric,
} from "../domain/config.ts";
import { parseHunks } from "../domain/patch.ts";
import type { ChangedFile, FileProfile, Finding, Screening, Signal } from "../domain/types.ts";

const client = new TypeSafeClient();

// Noul screening: one probability per dimension for a single changed file.
export async function screenFile(
  file: ChangedFile,
  changedTests: ChangedFile[],
): Promise<Screening> {
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

// Choice + Score: what kind of change is this and how closely to review it.
export async function profileFile(
  file: ChangedFile,
  screeningProbabilities: Record<Dimension, number>,
): Promise<FileProfile> {
  const response = await client.systemOne({
    state: { file, screeningProbabilities },
    questions: {
      changeType: choice("Which kind of change best describes file.patch?", changeTypes),
      reviewPriority: score(
        "Rate how closely a human should review file.patch, considering the code and screeningProbabilities.",
        [...reviewPriorityRubric],
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

// Staged follow-up for one signal: evidence hunk -> mechanism -> severity ->
// conditional owner routing. Returns null when any stage rejects the signal.
export async function locateSignal(signal: Signal): Promise<Finding | null> {
  const hunks = parseHunks(signal.file.patch);
  if (hunks.length === 0) return null;

  const suspectedConcern = {
    dimension: signal.dimension,
    definition: dimensions[signal.dimension],
  };

  const location = await client.systemOne({
    state: {
      file: signal.file.path,
      suspectedConcern: { ...suspectedConcern, screeningProbability: signal.probability },
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
  if (selected.choice === "noMatch" || selected.confidence < MIN_LOCATION_CONFIDENCE) {
    return null;
  }

  const hunk = hunks.find((candidate) => candidate.id === selected.choice);
  if (!hunk) return null;

  const classification = await client.systemOne({
    state: { file: signal.file.path, suspectedConcern, selectedHunk: hunk },
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
    state: { file: signal.file.path, suspectedConcern, selectedHunk: hunk },
    questions: {
      severity: score(
        "Assuming selectedHunk exhibits suspectedConcern, rate the likely impact if the changed code is used in production.",
        [...severityRubric],
      ),
    },
  });

  const severity = impact.answers.severity;
  let owner: string | null = null;
  let ownerConfidence: number | null = null;

  if (severity.score >= ROUTE_SEVERITY) {
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
        owner: choice("Which reviewer is best suited to investigate this concern?", owners),
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
    action: severity.score >= BLOCKING_SEVERITY ? "request_changes" : "comment",
  };
}
