import Ajv from "ajv";
import { groundedStatementSchema, id, ids, list, object } from "./schema.ts";
const gs = { $ref: "#/$defs/statement" },
  gsList = list(gs);
const nullableId = { anyOf: [id, { type: "null" }] };
const question = object({
  kind: { const: "question" },
  question: gs,
  reason: gs,
});
const envelope = {
  schemaVersion: { const: "3" },
  snapshotId: id,
  analysisStatus: { enum: ["complete", "partial", "insufficient_context"] },
  limitations: gsList,
  missingContext: list(object({ target: id, reason: gs, purpose: gs })),
};
const next = object({
  fileId: id,
  targetRevisionSha: id,
  evidenceIds: ids,
  reason: gs,
});
export const codeExplanationSchema = object({
  id,
  fileId: id,
  targetRevisionSha: id,
  comparisonFromSha: nullableId,
  selectedEvidenceIds: list(id, 100, 1),
  contextKind: {
    enum: ["changed_code", "unchanged_context", "selected_range"],
  },
  roleInPR: gs,
  responsibility: gs,
  inputsOutputs: gs,
  behavior: gs,
  beforeAfter: gs,
  sideEffects: gs,
  errorHandling: gs,
  answerToQuestion: gs,
  relationships: list(
    object({
      kind: { enum: ["static_graph", "inferred_suggestion"] },
      referenceId: id,
      explanation: gs,
    }),
  ),
  requirementLinks: list(object({ requirementId: id, explanation: gs })),
  testEvidenceIds: ids,
  reviewQuestions: list(question),
  nextReadingSuggestions: list(next),
});
export const tourSchema = object({
  tourId: id,
  tourRevisionSha: id,
  title: gs,
  rationale: gs,
  summary: gs,
  steps: list(
    object({
      id,
      title: gs,
      targetRevisionSha: id,
      comparisonFromSha: nullableId,
      historical: { type: "boolean" },
      historicalReason: gs,
      prerequisiteStepIds: ids,
      whyNow: gs,
      previousConnection: gs,
      explanation: gs,
      beforeAfter: gs,
      relationToGoal: gs,
      focusFileIds: list(id, 100, 1),
      focusHunkIds: ids,
      focusEvidenceIds: list(id, 100, 1),
      focusGraphEdgeIds: ids,
      requirementIds: ids,
      checkpointQuestions: list(question),
      nextTransition: gs,
    }),
    30,
  ),
  storyEdges: list(
    object({
      id,
      fromStepId: id,
      toStepId: id,
      relation: { const: "next_reading" },
      reason: gs,
    }),
  ),
});
const synthesis = {
  ...envelope,
  overview: object(
    Object.fromEntries(
      [
        "oneLiner",
        "problem",
        "statedIntent",
        "inferredIntent",
        "previousBehavior",
        "newBehavior",
        "strategy",
        "nonGoals",
      ].map((k) => [k, gs]),
    ),
  ),
  changeGroups: list(
    object({
      id,
      title: gs,
      purpose: gs,
      fileIds: ids,
      commitShas: ids,
      evidenceIds: ids,
    }),
  ),
  phaseSummaries: list(
    object({
      commitSha: id,
      comparisonFromSha: nullableId,
      title: gs,
      before: gs,
      changes: gs,
      why: gs,
      limitationsOfPhase: gs,
      focusFileIds: ids,
      focusGraphEdgeIds: ids,
      focusHunkIds: ids,
    }),
  ),
  requirements: list(
    object({
      id,
      sourceRole: {
        enum: [
          "explicit_acceptance_criteria",
          "extracted_requirement",
          "interpretation_proposal",
        ],
      },
      sourceEvidenceIds: list(id, 100, 1),
      statement: gs,
    }),
  ),
  requirementMappings: list(
    object({
      requirementId: id,
      status: {
        enum: [
          "supported_by_code",
          "partial_support",
          "not_demonstrated",
          "contradicted",
          "unknown",
        ],
      },
      explanation: gs,
      commitShas: ids,
      fileIds: ids,
      evidenceIds: ids,
      testEvidenceIds: ids,
    }),
  ),
  codeExplanations: list(codeExplanationSchema),
  discrepancies: list(
    object({
      id,
      requirementIds: ids,
      sourceEvidenceIds: list(id, 100, 1),
      codeEvidenceIds: list(id, 100, 1),
      explanation: gs,
      resolution: gs,
    }),
  ),
  inferredEdgeSuggestions: list(
    object({
      id,
      fromFileId: id,
      toFileId: id,
      revisionSha: id,
      relationType: {
        enum: [
          "import_usage",
          "possible_call",
          "data_flow",
          "test_relation",
          "configuration_impact",
        ],
      },
      evidenceSource: { const: "inferred" },
      explanation: gs,
    }),
  ),
  reviewQuestions: list(question),
};
const root = (properties: Record<string, unknown>) => ({
  ...object(properties),
  $defs: { statement: groundedStatementSchema },
});
export const chunkOutputSchema = root({
  ...envelope,
  taskId: id,
  summary: gs,
  findings: list(gs, 100, 1),
  codeExplanations: list(codeExplanationSchema),
});
export const synthesisOutputSchema = root(synthesis);
export const tourOutputSchema = root({ ...envelope, tour: tourSchema });
export const v3OutputSchema = root({ ...synthesis, tour: tourSchema });
const ajv = new Ajv({ strict: true, allErrors: true });
export const schemaChecks = {
  chunk: ajv.compile(chunkOutputSchema),
  synthesis: ajv.compile(synthesisOutputSchema),
  tour: ajv.compile(tourOutputSchema),
  output: ajv.compile(v3OutputSchema),
};
