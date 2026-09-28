import React from "react";
import type { Hunk } from "./server/git";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type ReaderFile = {
  id: string;
  path: string;
  status: string;
  oldPath: string | null;
  /** new side 원문 (삭제/미확보면 null) */
  content: string | null;
  /** old side 원문 */
  oldContent: string | null;
  retrieved: boolean;
  omission?: string;
  renameEvidence?: string | null;
  lineage?: string;
};
export type ReaderSelection = {
  side: "old" | "new";
  start: number | null;
  end: number | null;
};
export type CommitFileReaderProps = {
  file: ReaderFile;
  commitSha: string;
  comparisonSha: string | null;
  /** 이미 이 파일·이 비교 기준으로 필터링된 hunk */
  hunks: readonly Hunk[];
  partial: boolean;
  view: "diff" | "full";
  onViewChange: (view: "diff" | "full") => void;
  selection: ReaderSelection;
  /** 라인 번호 클릭. extend = Shift 클릭(범위 확장) */
  onSelectLine: (side: "old" | "new", line: number, extend: boolean) => void;
  /** 변경 목록 안의 위치(예: 2/5). 문맥 파일이면 null */
  position: { index: number; total: number } | null;
};

/**
 * 파일에 해당하는 hunk만 고른다. parseHunks가 이미 a/ b/ 접두어를 떼므로 경로는
 * 정확히 비교한다(실제 a/, b/ 디렉터리를 서로 섞지 않기 위해). 삭제 파일은 old
 * 경로로, 그 외(추가·수정·rename)는 new 경로로만 매칭한다.
 */
export function hunksForFile(
  hunks: readonly Hunk[],
  file: { path: string; oldPath: string | null; status: string },
): Hunk[] {
  return hunks.filter((h) =>
    file.status === "deleted"
      ? h.newPath === null && h.oldPath === (file.oldPath ?? file.path)
      : h.newPath === file.path,
  );
}

type DiffLine = {
  kind: "add" | "del" | "ctx" | "meta";
  text: string;
  oldNumber: number | null;
  newNumber: number | null;
};

/** hunk.text의 첫 줄은 `@@` header, 이후가 본문이다. 라인 번호는 start에서 센다. */
function hunkBodyLines(hunk: Hunk): DiffLine[] {
  const raw = hunk.text.split("\n");
  raw.shift();
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  return raw.map((text) => {
    const prefix = text[0];
    if (prefix === "+")
      return { kind: "add", text, oldNumber: null, newNumber: newLine++ };
    if (prefix === "-")
      return { kind: "del", text, oldNumber: oldLine++, newNumber: null };
    if (prefix === " ")
      return { kind: "ctx", text, oldNumber: oldLine++, newNumber: newLine++ };
    // `\ No newline at end of file` 등 번호 없는 줄
    return { kind: "meta", text, oldNumber: null, newNumber: null };
  });
}

function inSelection(
  selection: ReaderSelection,
  side: "old" | "new",
  n: number | null,
): boolean {
  if (n === null || selection.side !== side || selection.start === null)
    return false;
  const end = selection.end ?? selection.start;
  return n >= selection.start && n <= end;
}

/** Last path segment stays bold; the directory prefix is dimmed. */
function PathLabel({ path }: { path: string }): React.ReactElement {
  const split = path.lastIndexOf("/");
  if (split < 0)
    return (
      <h3 className="commit-file-reader-path">
        <b className="commit-file-reader-name">{path}</b>
      </h3>
    );
  return (
    <h3 className="commit-file-reader-path">
      <span className="commit-file-reader-dir">{path.slice(0, split + 1)}</span>
      <b className="commit-file-reader-name">{path.slice(split + 1)}</b>
    </h3>
  );
}

export function CommitFileReader(
  props: CommitFileReaderProps,
): React.ReactElement {
  const {
    file,
    commitSha,
    comparisonSha,
    hunks,
    partial,
    view,
    onViewChange,
    selection,
    onSelectLine,
    position,
  } = props;

  // No hooks: the reader stays a pure element tree. The ref callback scrolls the
  // selected line into the reader's own scroll area (React re-runs it per commit).
  const scrollRef = (node: HTMLDivElement | null) => {
    if (!node || selection.start === null) return;
    node
      .querySelector<HTMLElement>(
        `[data-select-side="${selection.side}"][data-select-line="${selection.start}"]`,
      )
      ?.scrollIntoView({ block: "nearest" });
  };

  const renamed =
    file.status === "renamed" ||
    (file.oldPath !== null && file.oldPath !== file.path);

  const fullPane = (side: "old" | "new") => {
    const sha = side === "old" ? comparisonSha : commitSha;
    const content =
      side === "old"
        ? file.oldContent
        : file.status === "deleted" || !file.retrieved
          ? null
          : file.content;
    return (
      <div
        className="code-pane commit-file-reader-pane"
        data-testid={"live-code-" + side}
      >
        <h4>
          {side} · {sha ? sha.slice(0, 12) : ""}
        </h4>
        {content === null ? (
          <p>이 side에 내용 없음 / 확보 안 됨</p>
        ) : (
          <pre>
            {content
              .replace(/\n$/, "")
              .split("\n")
              .map((line, i) => {
                const n = i + 1;
                return (
                  <div
                    key={i}
                    className={
                      inSelection(selection, side, n) ? "highlight" : ""
                    }
                  >
                    <button
                      type="button"
                      className="line"
                      onClick={(event) => onSelectLine(side, n, event.shiftKey)}
                    >
                      {n}
                    </button>
                    <code>{line || " "}</code>
                  </div>
                );
              })}
          </pre>
        )}
      </div>
    );
  };

  const diffView = (
    <div className="commit-file-reader-diff">
      {hunks.map((hunk) => (
        <div key={hunk.id} className="commit-file-reader-hunk">
          <div className="commit-file-reader-hunk-header">{hunk.header}</div>
          {hunkBodyLines(hunk).map((line, i) => {
            const side: "old" | "new" = line.kind === "del" ? "old" : "new";
            const clickLine =
              line.kind === "del"
                ? line.oldNumber
                : line.kind === "add" || line.kind === "ctx"
                  ? line.newNumber
                  : null;
            const highlighted =
              inSelection(selection, "old", line.oldNumber) ||
              inSelection(selection, "new", line.newNumber);
            return (
              <div
                key={i}
                className={`commit-file-reader-line commit-file-reader-line-${line.kind}${
                  highlighted ? " commit-file-reader-line-highlight" : ""
                }`}
                data-select-side={clickLine === null ? undefined : side}
                data-select-line={clickLine === null ? undefined : clickLine}
              >
                <button
                  type="button"
                  className="commit-file-reader-num"
                  disabled={clickLine === null}
                  onClick={
                    clickLine === null
                      ? undefined
                      : (event) => onSelectLine(side, clickLine, event.shiftKey)
                  }
                >
                  {line.oldNumber ?? ""}
                </button>
                <button
                  type="button"
                  className="commit-file-reader-num"
                  disabled={clickLine === null}
                  onClick={
                    clickLine === null
                      ? undefined
                      : (event) => onSelectLine(side, clickLine, event.shiftKey)
                  }
                >
                  {line.newNumber ?? ""}
                </button>
                <code>{line.text || " "}</code>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );

  const emptyDiff = (
    <>
      <p className="commit-file-reader-empty">
        표시할 변경 구간 없음 · binary·mode 변경·rename만이거나 수집되지 않았을
        수 있습니다
      </p>
      <button type="button" onClick={() => onViewChange("full")}>
        전체 원문 보기
      </button>
    </>
  );

  const body =
    view === "diff" ? (
      hunks.length === 0 ? (
        emptyDiff
      ) : (
        diffView
      )
    ) : (
      <div className="commit-file-reader-grid">
        {fullPane("old")}
        {fullPane("new")}
      </div>
    );

  return (
    <section className="commit-file-reader" data-testid="commit-file-reader">
      <div className="commit-file-reader-header">
        <div className="commit-file-reader-title-row">
          <PathLabel path={file.path} />
          <span
            className={`commit-file-reader-status commit-file-reader-status-${file.status}`}
          >
            {file.status}
          </span>
          {position && (
            <p className="commit-file-reader-position">
              {`파일 ${position.index} / ${position.total}`}
            </p>
          )}
          <div
            className="commit-file-reader-views"
            role="group"
            aria-label="보기 선택"
          >
            <button
              type="button"
              aria-pressed={view === "diff"}
              onClick={() => onViewChange("diff")}
            >
              변경 구간
            </button>
            <button
              type="button"
              aria-pressed={view === "full"}
              onClick={() => onViewChange("full")}
            >
              전체 원문
            </button>
          </div>
        </div>
        {renamed && (
          <p className="commit-file-reader-rename">
            {file.oldPath ?? "?"} → {file.path}
            {file.renameEvidence && <small> · {file.renameEvidence}</small>}
            {file.lineage && <small> · lineage {file.lineage}</small>}
          </p>
        )}
      </div>
      {file.omission && (
        <p className="commit-file-reader-notice">
          {`원문 정책 제외: ${file.omission}. 빈 내용으로 분석하지 않았습니다.`}
        </p>
      )}
      {partial && (
        <p className="commit-file-reader-warning" role="status">
          부분 diff · 일부 변경만 캡처되었을 수 있습니다
        </p>
      )}
      <div
        className="commit-file-reader-scroll"
        ref={scrollRef}
        data-testid="commit-file-reader-scroll"
      >
        {body}
      </div>
      <p className="commit-file-reader-hint">
        라인 클릭 / Shift+클릭으로 범위 선택. 선택 SHA/side/라인 범위와 함께
        PR·Jira 원문 및 해당 커밋 원문 문맥이 전송될 수 있습니다.
      </p>
    </section>
  );
}
