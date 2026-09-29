import { commitFileChanges, type CommitPhase } from "./commit-review";

export type FlowTarget = { commit: string; file: string; side: "old" | "new" };

/** 커밋의 첫 변경 파일. 변경 파일이 없으면 file "" · side "new". */
export function firstFileTarget(phase: CommitPhase): FlowTarget {
  const [first] = commitFileChanges(phase);
  return first
    ? { commit: phase.sha, file: first.id, side: first.side }
    : { commit: phase.sha, file: "", side: "new" };
}

/** 커밋의 마지막 변경 파일. 없으면 file "". */
export function lastFileTarget(phase: CommitPhase): FlowTarget {
  const changes = commitFileChanges(phase);
  const last = changes[changes.length - 1];
  return last
    ? { commit: phase.sha, file: last.id, side: last.side }
    : { commit: phase.sha, file: "", side: "new" };
}

/** phases = Baseline을 제외한 실제 커밋들(순서대로). */
export function moveFileTarget(
  phases: readonly CommitPhase[],
  current: { commit: string; file: string },
  direction: -1 | 1,
): FlowTarget | null {
  const index = phases.findIndex((p) => p.sha === current.commit);

  // Baseline (or an unknown commit) sits before every real commit: going
  // forward enters the first commit, going back has nowhere to land.
  if (index === -1) {
    if (direction === -1) return null;
    const first = phases[0];
    return first ? firstFileTarget(first) : null;
  }

  const phase = phases[index];
  const changes = commitFileChanges(phase);
  const position = changes.findIndex((c) => c.id === current.file);

  // Current file is one of this commit's changes: step within the list, then
  // cross to the neighbouring commit's edge (keeping empty commits as stops).
  if (position !== -1) {
    if (direction === 1) {
      const next = changes[position + 1];
      if (next) return { commit: phase.sha, file: next.id, side: next.side };
      const nextPhase = phases[index + 1];
      return nextPhase ? firstFileTarget(nextPhase) : null;
    }
    const previous = changes[position - 1];
    if (previous)
      return { commit: phase.sha, file: previous.id, side: previous.side };
    const previousPhase = phases[index - 1];
    return previousPhase ? lastFileTarget(previousPhase) : null;
  }

  // current.file is "" (no selection / empty commit) or a context file that is
  // not in the change list.
  if (direction === 1) {
    if (changes.length) return firstFileTarget(phase);
    const nextPhase = phases[index + 1];
    return nextPhase ? firstFileTarget(nextPhase) : null;
  }
  const previousPhase = phases[index - 1];
  return previousPhase ? lastFileTarget(previousPhase) : null;
}

/** 현재 파일의 변경 목록 내 위치(1-based). 변경 목록에 없으면 null. */
export function filePosition(
  phase: CommitPhase,
  fileId: string,
): { index: number; total: number } | null {
  const changes = commitFileChanges(phase);
  const index = changes.findIndex((c) => c.id === fileId);
  if (index === -1) return null;
  return { index: index + 1, total: changes.length };
}

/** nav()에 넘길 URL patch. 이전 라인 범위·투어 단계를 비운다. */
export function flowNavigationPatch(
  target: FlowTarget,
  phase: CommitPhase,
): Record<string, string> {
  return {
    commit: target.commit,
    comparison: phase.comparisonFromSha || "",
    file: target.file,
    side: target.side,
    start: "",
    end: "",
    step: "",
    mode: "Code Explorer",
  };
}
