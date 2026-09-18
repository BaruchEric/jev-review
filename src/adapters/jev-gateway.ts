// Jev client selection. The review code calls client.systemOne() with the
// TypeSafe SDK's question helpers and reads the SDK's answer shapes. This module
// keeps that contract while letting the request travel one of two ways:
//
//   TYPESAFE_API_KEY set     -> the SDK's own TypeSafeClient, straight to TypeSafe
//   AI_GATEWAY_API_KEY set   -> experimental_evaluate from the AI SDK through the
//                               Vercel AI Gateway (model typesafe-ai/jev)
//
// The gateway path exists because a Vercel project often already has a gateway key
// and no TypeSafe account. The AI SDK calls Noul "boolean" and returns confidence
// in provider metadata rather than on each answer, so the adapter maps both ways.
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

export interface JevClient {
  systemOne<const Q extends Questions>(
    request: Pick<SystemOneRequest<Q>, "state" | "questions">,
  ): Promise<SystemOneResult<Q>>;
}

export const GATEWAY_MODEL = process.env.JEV_GATEWAY_MODEL ?? "typesafe-ai/jev";

/** Jev answers in a few hundred ms; the gateway occasionally hangs, so attempts are short and retried. */
const ATTEMPT_TIMEOUT_MS = 8000;
const ATTEMPTS = 3;

export function createJevClient(): JevClient {
  if (process.env.TYPESAFE_API_KEY) return new TypeSafeClient();
  if (process.env.AI_GATEWAY_API_KEY) return createGatewayClient(process.env.AI_GATEWAY_API_KEY);
  throw new Error(
    "No Jev credentials. Set TYPESAFE_API_KEY (TypeSafe direct) or AI_GATEWAY_API_KEY (Vercel AI Gateway) in .env.",
  );
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

function readConfidence(meta: unknown): Record<string, number> {
  if (typeof meta !== "object" || meta === null) return {};
  const typesafe = (meta as { typesafe?: unknown }).typesafe;
  if (typeof typesafe !== "object" || typesafe === null) return {};
  const confidence = (typesafe as { confidence?: unknown }).confidence;
  if (typeof confidence !== "object" || confidence === null) return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(confidence as Record<string, unknown>)) {
    if (typeof value === "number") out[id] = value;
  }
  return out;
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
