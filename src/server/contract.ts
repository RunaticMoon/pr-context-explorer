import Ajv from "ajv";
import { hash, type Snapshot, type Evidence } from "./git.ts";
export type Statement = {
  text: string;
  kind: "observed" | "inferred" | "unknown";
  evidenceIds: string[];
  confidence: "high" | "medium" | "low";
  limitation: string;
  commitSha: string;
};
export type Step = {
  id: string;
  title: string;
  why: string;
  previous: string;
  next: string;
  question: string;
  beforeAfter: string;
  revisionSha: string;
  comparisonFromSha: string;
  fileIds: string[];
  evidenceIds: string[];
  prerequisites: string[];
  requirementIds: string[];
};
export type CodeExplanation = {
  evidenceId: string;
  role: string;
  inputsOutputs: string;
  behavior: string;
  errors: string;
  sideEffects: string;
  kind: "observed";
  limitation: string;
};
export type Analysis = {
  schemaVersion: "1";
  snapshotId: string;
  provider: "MockProvider";
  analysisStatus: "partial";
  limitations: string[];
  missingContext: string[];
  statements: Statement[];
  steps: Step[];
  codeExplanations: CodeExplanation[];
  semanticAudit: "not_performed";
};
const str = { type: "string", maxLength: 10000 };
const arr = { type: "array", items: str, maxItems: 100 };
const obj = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
export const outputSchema = obj({
  schemaVersion: { const: "1" },
  snapshotId: str,
  provider: { const: "MockProvider" },
  analysisStatus: { const: "partial" },
  limitations: arr,
  missingContext: arr,
  semanticAudit: { const: "not_performed" },
  codeExplanations: {
    type: "array",
    maxItems: 200,
    items: obj({
      evidenceId: str,
      role: str,
      inputsOutputs: str,
      behavior: str,
      errors: str,
      sideEffects: str,
      kind: { const: "observed" },
      limitation: str,
    }),
  },
  statements: {
    type: "array",
    minItems: 1,
    maxItems: 100,
    items: obj({
      text: str,
      kind: { enum: ["observed", "inferred", "unknown"] },
      evidenceIds: arr,
      confidence: { enum: ["high", "medium", "low"] },
      limitation: str,
      commitSha: str,
    }),
  },
  steps: {
    type: "array",
    minItems: 1,
    maxItems: 30,
    items: obj({
      id: str,
      title: str,
      why: str,
      previous: str,
      next: str,
      question: str,
      beforeAfter: str,
      revisionSha: str,
      comparisonFromSha: str,
      fileIds: arr,
      evidenceIds: arr,
      prerequisites: arr,
      requirementIds: arr,
    }),
  },
});
const check = new Ajv({ strict: true, allErrors: true }).compile(outputSchema);
function requireValid(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(message);
}
export function validateEvidence(e: Evidence, s: Snapshot) {
  requireValid(e.snapshotId === s.snapshotId, "evidence snapshot");
  const phase = [s.baseline, ...s.phases].find((p) => p.sha === e.commitSha);
  requireValid(phase, "evidence commit");
  requireValid(e.side === "old" || e.side === "new", "evidence side");
  requireValid(
    e.comparisonFromSha === phase.comparisonFromSha,
    "evidence comparison",
  );
  requireValid(
    e.revisionSha === (e.side === "old" ? phase.comparisonFromSha : phase.sha),
    "evidence revision",
  );
  const f = phase.files.find((f) => f.id === e.fileId);
  requireValid(f, "evidence file");
  const old = e.side === "old";
  requireValid(
    old ? f.oldContent !== null : f.status !== "deleted",
    "evidence existence",
  );
  const content = old ? f.oldContent! : f.content;
  requireValid(
    e.path === (old ? f.oldPath : f.path) &&
      e.blobSha === (old ? f.oldBlobSha : f.blobSha),
    "evidence path/blob",
  );
  requireValid(e.contentHash === hash(content), "evidence hash");
  requireValid(
    Number.isInteger(e.lineStart) &&
      Number.isInteger(e.lineEnd) &&
      e.lineStart >= 1 &&
      e.lineEnd >= e.lineStart &&
      e.lineEnd <= content.replace(/\n$/, "").split("\n").length,
    "evidence range",
  );
}
export function validateAnalysis(value: unknown, s: Snapshot): void {
  requireValid(JSON.stringify(value).length <= 200000, "output size");
  requireValid(check(value), JSON.stringify(check.errors));
  const a = value as Analysis;
  requireValid(a.snapshotId === s.snapshotId, "snapshot mismatch");
  const evidence = new Map(s.evidence.map((e) => [e.id, e]));
  for (const e of s.evidence) validateEvidence(e, s);
  for (const x of a.statements) {
    requireValid(
      [s.baseline, ...s.phases].some((p) => p.sha === x.commitSha),
      "statement revision",
    );
    requireValid(
      x.kind === "unknown" ? !!x.limitation : x.evidenceIds.length > 0,
      "important claim requires evidence",
    );
    requireValid(
      x.kind !== "inferred" || !!x.limitation,
      "inference rationale",
    );
    for (const id of x.evidenceIds)
      requireValid(
        evidence.get(id)?.commitSha === x.commitSha,
        "statement evidence revision",
      );
  }
  for (const code of a.codeExplanations)
    requireValid(evidence.has(code.evidenceId), "code evidence");
  const seen = new Set<string>();
  for (const step of a.steps) {
    requireValid(!seen.has(step.id), "duplicate step");
    requireValid(
      step.prerequisites.every((p) => seen.has(p)),
      "cyclic/unknown prerequisite",
    );
    seen.add(step.id);
    requireValid(
      step.revisionSha === s.headSha &&
        step.comparisonFromSha === s.phases.at(-1)!.comparisonFromSha,
      "head tour revision",
    );
    requireValid(
      step.fileIds.length &&
        step.fileIds.every((id) =>
          s.phases
            .at(-1)!
            .files.some((f) => f.id === id && f.status !== "deleted"),
        ),
      "tour file",
    );
    requireValid(step.evidenceIds.length, "tour evidence");
    for (const id of step.evidenceIds) {
      const e = evidence.get(id);
      requireValid(
        e &&
          e.commitSha === step.revisionSha &&
          step.fileIds.includes(e.fileId),
        "tour evidence scope",
      );
    }
    requireValid(
      step.requirementIds.every((id) => id === s.jira.key),
      "requirement ref",
    );
  }
}
