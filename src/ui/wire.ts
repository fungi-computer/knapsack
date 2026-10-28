import { defineIdFamily } from "@fungi.computer/cairn";
import * as z from "zod";

export const uiWireIds = defineIdFamily({
  family: "knapsack-ui",
  version: 1,
  kinds: {
    request: { prefix: "ui_request" },
    connection: { prefix: "ui_connection" },
    claim: { prefix: "ui_claim" },
    attempt: { prefix: "ui_attempt" },
  },
});

const identifier = z.string().min(1).max(256);
const requestId = z
  .string()
  .refine((value) => uiWireIds.request.parse(value).ok);
const json = z.json();
const schemaDocument = z.record(z.string(), json);
export const BrowserWireObjectSchema = z.record(z.string(), z.unknown());
export type BrowserWireObject = z.output<typeof BrowserWireObjectSchema>;
const WhistleAvailabilitySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("available") }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

/** The same descriptor is decoded at browser ingress and in model tool results. */
const commandKey = z.strictObject({ namespace: identifier, id: identifier });
const browserCommandRowFields = {
  command: commandKey,
  sourceId: identifier,
  title: z.string(),
  category: z.string(),
  description: z.string().nullable(),
  order: z.number(),
  keybind: z.string().nullable(),
  availability: WhistleAvailabilitySchema,
} as const;
const browserActionSchema = z.union([
  z
    .object({ inputSchema: schemaDocument, outputSchema: schemaDocument })
    .strict(),
  z.object({ inputSchema: schemaDocument }).strict(),
  z.object({ outputSchema: schemaDocument }).strict(),
]);
const browserCommandRowWithActionSchema = z
  .object({ ...browserCommandRowFields, action: browserActionSchema })
  .strict();
const browserCommandRowWithoutActionSchema = z
  .object(browserCommandRowFields)
  .strict();
export const BrowserCommandRowSchema = z.union([
  browserCommandRowWithActionSchema,
  browserCommandRowWithoutActionSchema,
]);

// Whistle answers an empty or unknown key itself, as `invalid` or `missing`.
const browserExecuteCommandSchema = z.object({
  command: z.strictObject({
    namespace: z.string().max(256),
    id: z.string().max(256),
  }),
});
const browserExecuteInputWireSchema = browserExecuteCommandSchema
  .extend({ arguments: json })
  .strict();
const browserExecuteInputWithoutArgumentsSchema =
  browserExecuteCommandSchema.strict();
export const BrowserExecuteInputSchema = z.union([
  browserExecuteInputWireSchema,
  browserExecuteInputWithoutArgumentsSchema,
]);

const BrowserRequestSchema = z.union([
  z.object({ type: z.literal("discover") }).strict(),
  browserExecuteInputWireSchema.extend({ type: z.literal("execute") }),
  browserExecuteInputWithoutArgumentsSchema.extend({
    type: z.literal("execute"),
  }),
]);
const BrowserRequestEnvelopeSchema = z.object({
  requestId,
  request: BrowserRequestSchema,
});
export const BrowserRequestDeliverySchema = BrowserRequestEnvelopeSchema.extend(
  {
    connectionId: z
      .string()
      .refine((value) => uiWireIds.connection.parse(value).ok),
  },
);
export const BrowserClaimSchema = z.object({
  requestId,
  connectionId: z
    .string()
    .refine((value) => uiWireIds.connection.parse(value).ok),
  attemptId: z.string().refine((value) => uiWireIds.attempt.parse(value).ok),
});
export const BrowserClaimResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed"), claimId: z.string() }),
  z.object({
    status: z.literal("waiting"),
    retryAfterMs: z.number().int().min(10).max(1_000),
  }),
  z.object({ status: z.literal("skipped") }),
]);

export const BrowserExecutionOutcomeSchema = z.union([
  z.object({ status: z.literal("handled"), result: json }).strict(),
  z.object({ status: z.literal("handled") }).strict(),
  z.object({ status: z.literal("closed") }).strict(),
  z.object({ status: z.literal("missing") }).strict(),
  z.object({ status: z.literal("invalid") }).strict(),
  z.object({ status: z.literal("unavailable"), reason: z.string() }).strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.object({
        code: z.string(),
        message: z.string(),
        details: json,
      }),
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: z.object({ code: z.string(), message: z.string() }).strict(),
    })
    .strict(),
]);
const BrowserWireResultSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("discover"),
    commands: z.array(BrowserCommandRowSchema),
  }),
  z.object({
    type: z.literal("execute"),
    outcome: BrowserExecutionOutcomeSchema,
  }),
]);
export const BrowserResultEnvelopeSchema = z.object({
  requestId,
  claimId: z.string().refine((value) => uiWireIds.claim.parse(value).ok),
  result: BrowserWireResultSchema,
});
export const BrowserSettlementResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("accepted") }),
  z.object({ status: z.literal("ignored") }),
]);

export type BrowserCommandRow = z.output<typeof BrowserCommandRowSchema>;
export type BrowserRequest = z.output<typeof BrowserRequestSchema>;
export type BrowserRequestEnvelope = z.output<
  typeof BrowserRequestEnvelopeSchema
>;
export type BrowserRequestDelivery = z.output<
  typeof BrowserRequestDeliverySchema
>;
export type BrowserClaim = z.output<typeof BrowserClaimSchema>;
export type BrowserClaimResult = z.output<typeof BrowserClaimResultSchema>;
export type BrowserWireResult = z.output<typeof BrowserWireResultSchema>;
export type BrowserResultEnvelope = z.output<
  typeof BrowserResultEnvelopeSchema
>;
export type BrowserSettlementResult = z.output<
  typeof BrowserSettlementResultSchema
>;
