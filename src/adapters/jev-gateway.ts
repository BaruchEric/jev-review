// Jev client selection and usage accounting. The review code calls
// client.systemOne() with the TypeSafe SDK's question helpers and reads the SDK's
// answer shapes. This module keeps that contract while letting the request travel
// one of two ways:
//
//   TYPESAFE_API_KEY set     -> the SDK's own TypeSafeClient, straight to TypeSafe
//   AI_GATEWAY_API_KEY set   -> experimental_evaluate from the AI SDK through the
//                               Vercel AI Gateway (model typesafe-ai/jev)
//
// The gateway path exists because a Vercel project often already has a gateway key
// and no TypeSafe account. The AI SDK calls Noul "boolean" and returns confidence
// in provider metadata rather than on each answer, so the adapter maps both ways.
//
// Every call is also tallied into a process-wide ledger (calls, tokens, cost when
// the route reports it, wall time) that the report and the CLI summary read.
import { createGateway } from "@ai-sdk/gateway";
import {
  APICallError,
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as GatewayQuestion,
} from "ai";
import {
  type Question,
  type Questions,
  type SystemOneRequest,
  type SystemOneResult,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { JevUsage } from "../domain/types.ts";

export interface JevClient {
  systemOne<const Q extends Questions>(
    request: Pick<SystemOneRequest<Q>, "state" | "questions">,
  ): Promise<SystemOneResult<Q>>;
}

export const GATEWAY_MODEL = process.env.JEV_GATEWAY_MODEL ?? "typesafe-ai/jev";

/** Jev answers in a few hundred ms; the gateway occasionally hangs, so attempts are short and retried. */
const ATTEMPT_TIMEOUT_MS = 8000;
const ATTEMPTS = 3;

const ledger: JevUsage = emptyUsage("typesafe");

function emptyUsage(route: JevUsage["route"]): JevUsage {
  return { route, model: null, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: null, latencyMs: 0 };
}

/** Start a fresh tally; a review calls this once before its first judgment. */
export function resetUsage(): void {
  Object.assign(ledger, emptyUsage(ledger.route));
}

/** A copy of the tally so far. costUsd stays null on routes that do not price calls. */
export function readUsage(): JevUsage {
  return { ...ledger };
}

function record(
  route: JevUsage["route"],
  model: string,
  tokens: { input: number; output: number },
  costUsd: number | undefined,
  latencyMs: number,
): void {
  ledger.route = route;
  ledger.model = model;
  ledger.calls += 1;
  ledger.inputTokens += tokens.input;
  ledger.outputTokens += tokens.output;
  ledger.latencyMs += Math.round(latencyMs);
  if (costUsd !== undefined) ledger.costUsd = (ledger.costUsd ?? 0) + costUsd;
}

export function createJevClient(): JevClient {
  if (process.env.TYPESAFE_API_KEY) return createDirectClient();
  if (process.env.AI_GATEWAY_API_KEY) return createGatewayClient(process.env.AI_GATEWAY_API_KEY);
  throw new Error(
    "No Jev credentials. Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in .env.",
  );
}

function createDirectClient(): JevClient {
  const client = new TypeSafeClient();
  ledger.route = "typesafe";
  return {
    async systemOne<const Q extends Questions>(request: Pick<SystemOneRequest<Q>, "state" | "questions">) {
      const started = performance.now();
      const result = await client.systemOne(request);
      record(
        "typesafe",
        result.model,
        { input: result.usage.input_tokens, output: result.usage.output_tokens },
        undefined,
        performance.now() - started,
      );
      return result;
    },
  };
}

function toGatewayQuestion(question: Question): GatewayQuestion {
  switch (question.type) {
    case "noul":
      return question.criteria
        ? { type: "boolean", instructions: question.instructions ?? "", criteria: question.criteria }
        : { type: "boolean", instructions: question.instructions ?? "" };
    case "choice":
      return { type: "choice", instructions: question.instructions ?? "", criteria: question.criteria };
    case "score":
      return { type: "score", instructions: question.instructions ?? "", criteria: [...question.criteria] };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readConfidence(meta: unknown): Record<string, number> {
  const confidence = asRecord(asRecord(asRecord(meta)?.typesafe)?.confidence);
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(confidence ?? {})) {
    if (typeof value === "number") out[id] = value;
  }
  return out;
}

/** The gateway prices each call and reports it as a string or number in its metadata. */
function readCost(meta: unknown): number | undefined {
  const cost = asRecord(asRecord(meta)?.gateway)?.cost;
  if (typeof cost !== "number" && typeof cost !== "string") return undefined;
  const n = Number(cost);
  return Number.isFinite(n) ? n : undefined;
}

function topProbability(probabilities: Record<string, number> | undefined, key: string): number {
  return probabilities?.[key] ?? 1;
}

function isRetryable(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  return true;
}

function createGatewayClient(apiKey: string): JevClient {
  const gateway = createGateway({ apiKey });
  ledger.route = "gateway";
  return {
    async systemOne<const Q extends Questions>(request: Pick<SystemOneRequest<Q>, "state" | "questions">) {
      // The SDK allows a null state; the AI SDK does not, and a review with no
      // evidence is a caller bug either way.
      const { state } = request;
      if (state === null) throw new Error("Jev request has no state to judge");
      const questions: Record<string, GatewayQuestion> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        questions[id] = toGatewayQuestion(question);
      }

      const started = performance.now();
      let result: Awaited<ReturnType<typeof evaluate>> | undefined;
      for (let attempt = 1; result === undefined; attempt++) {
        try {
          result = await evaluate({
            model: gateway.evaluationModel(GATEWAY_MODEL),
            state,
            questions,
            maxRetries: 0,
            abortSignal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
          });
        } catch (error) {
          if (attempt >= ATTEMPTS || !isRetryable(error)) throw error;
        }
      }
      record(
        "gateway",
        result.response.modelId,
        { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 },
        readCost(result.providerMetadata),
        performance.now() - started,
      );

      const confidence = readConfidence(result.providerMetadata);
      const answers: Record<string, unknown> = {};
      for (const [id, question] of Object.entries(request.questions)) {
        const answer = result.answers[id];
        if (question.type === "noul" && answer.type === "boolean") {
          answers[id] = { type: "noul", noul: answer.probability };
        } else if (question.type === "choice" && answer.type === "choice") {
          const probabilities = answer.probabilities ?? { [answer.choice]: 1 };
          answers[id] = {
            type: "choice",
            choice: answer.choice,
            confidence: confidence[id] ?? topProbability(probabilities, answer.choice),
            probabilities,
          };
        } else if (question.type === "score" && answer.type === "score") {
          const legend: Record<string, unknown> = {};
          question.criteria.forEach((level, index) => {
            legend[String(index)] = level;
          });
          const nearest = String(Math.round(answer.score));
          const probabilities = answer.probabilities ?? { [nearest]: 1 };
          answers[id] = {
            type: "score",
            score: answer.score,
            confidence: confidence[id] ?? topProbability(probabilities, nearest),
            legend,
            probabilities,
          };
        } else {
          throw new Error(`Gateway answered question "${id}" with type ${answer.type}, expected ${question.type}`);
        }
      }

      // Every answer above was checked against its question; this is the one
      // place the generic map is asserted into the SDK's per-question shape.
      return {
        model: result.response.modelId,
        answers: answers as SystemOneResult<Q>["answers"],
        usage: {
          input_tokens: result.usage.inputTokens ?? 0,
          output_tokens: result.usage.outputTokens ?? 0,
        },
      };
    },
  };
}
