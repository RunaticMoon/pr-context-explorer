import React, { useEffect, useRef, useState } from "react";

// CONTRACT (conductor-owned): implement body only; keep the exported names and prop shapes.
export type QuickFilter = {
  id: string;
  name: string;
  query: string;
  builtin?: true;
};

type API = (route: string, method?: string, body?: unknown) => Promise<any>;

export type PrSearchPanelProps = {
  api: API;
  /** 선택된 연결 id, 없으면 "". */
  connectionId: string;
  /** 부모 busy 상태. */
  disabled: boolean;
  /** CSRF(세션) 준비 여부. true가 되기 전에는 요청을 보내지 않는다. */
  ready: boolean;
  /** 부모의 guard: 예외를 잡아 상태 메시지로 표시. */
  run: (fn: () => Promise<void>) => unknown;
  /** "이 PR 수집". */
  onCapture: (htmlUrl: string) => void;
};

/** 충돌하면 "-2", "-3"… 접미를 붙인 새 커스텀 퀵필터 id. */
export function newQuickFilterId(existing: string[], now = Date.now()): string {
  const base = "qf-" + now.toString(36);
  if (!existing.includes(base)) return base;
  let suffix = 2;
  while (existing.includes(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/**
 * 이름/쿼리를 trim해 추가하거나, id가 있으면 그 항목을 교체한다.
 * 빈 이름·쿼리와 50개 초과 추가는 거부한다.
 */
export function upsertQuickFilter(
  list: QuickFilter[],
  name: string,
  query: string,
  id?: string,
): QuickFilter[] {
  const trimmedName = name.trim();
  const trimmedQuery = query.trim();
  if (!trimmedName || !trimmedQuery) throw Error("이름과 쿼리를 입력하세요");
  if (id) {
    const index = list.findIndex((f) => f.id === id);
    const entry: QuickFilter = { id, name: trimmedName, query: trimmedQuery };
    if (index >= 0) {
      const next = list.slice();
      next[index] = entry;
      return next;
    }
    if (list.length >= 50) throw Error("퀵필터는 최대 50개");
    return [...list, entry];
  }
  if (list.length >= 50) throw Error("퀵필터는 최대 50개");
  return [
    ...list,
    {
      id: newQuickFilterId(list.map((f) => f.id)),
      name: trimmedName,
      query: trimmedQuery,
    },
  ];
}

/** id에 해당하는 퀵필터만 제거한 새 목록. */
export function removeQuickFilter(
  list: QuickFilter[],
  id: string,
): QuickFilter[] {
  return list.filter((f) => f.id !== id);
}

/**
 * 저장 요청 직전의 목록에서 다음 목록을 계산한다.
 * 같은 이름이 있으면 그 항목을 교체하고, 없으면 새로 추가한다.
 */
export function planSaveQuickFilter(
  list: QuickFilter[],
  nameDraft: string,
  query: string,
): QuickFilter[] {
  const existing = list.find((f) => f.name === nameDraft.trim());
  return upsertQuickFilter(list, nameDraft, query, existing?.id);
}

/** 발급된 요청 시퀀스가 마지막 요청인지 판별한다(역전된 응답 무시용). */
export function isLatestRequest(seq: number, latest: number): boolean {
  return seq === latest;
}

/**
 * `promise`가 `ms` 안에 정착하지 않으면 `message` 오류로 거부한다.
 * 제시간에 정착하면 결과/오류를 그대로 전달하고 타이머를 정리한다.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** 검색 요청 타임아웃(ms). 무응답 시 잠김을 막는다. */
export const SEARCH_TIMEOUT_MS = 60_000;

/** 검색 버튼을 누를 수 있는 상태인지(세션 준비·연결·busy·진행 중). */
export function canSearch(state: {
  ready: boolean;
  connectionId: string;
  disabled: boolean;
  searching: boolean;
}): boolean {
  return (
    state.ready && !!state.connectionId && !state.disabled && !state.searching
  );
}

/** ISO 시각을 로컬 `YYYY-MM-DD HH:mm`로. null/빈 값/잘못된 값은 "". */
export function formatUpdated(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

const HELP_ROWS: Array<[string, string]> = [
  ["author:@me", "내가 작성한 PR"],
  ["review-requested:@me", "내 리뷰가 요청된 PR"],
  ["reviewed-by:@me", "내가 리뷰한 PR"],
  ["involves:@me", "작성·리뷰·멘션 등 나와 관련된 PR"],
  ["assignee:사용자", "지정된 담당자가 있는 PR"],
  ["mentions:사용자", "본문·댓글에서 멘션한 사용자"],
  ["repo:owner/name", "특정 저장소로 한정"],
  ["org:조직", "특정 조직으로 한정"],
  ['label:"이름"', "특정 라벨이 붙은 PR"],
  ["is:open|closed|merged", "상태로 한정"],
  ["draft:true|false", "Draft 여부로 한정"],
  ["base:브랜치", "병합 대상 브랜치로 한정"],
  ["head:브랜치", "작업 브랜치로 한정"],
  ["created:/updated:/merged:>=YYYY-MM-DD", "날짜 범위로 한정"],
  ["-한정자", "조건 제외(예: -author:bot)"],
  ['"구문 검색"', "공백 포함 문구를 그대로 검색"],
  ["일반 단어", "제목·본문에서 단어 검색"],
];

export function PrSearchPanel({
  api,
  connectionId,
  disabled,
  ready,
  run,
  onCapture,
}: PrSearchPanelProps): React.ReactElement {
  const [query, setQuery] = useState("is:open author:@me");
  // Page moves reuse the query of the last executed search, not `list.query`.
  const [lastQuery, setLastQuery] = useState("");
  const [list, setList] = useState<any>(null);
  const [builtin, setBuiltin] = useState<QuickFilter[]>([]);
  const [custom, setCustomState] = useState<QuickFilter[]>([]);
  // Always mirror the latest custom list so request payloads are computed from
  // current state, not a stale render closure.
  const customRef = useRef<QuickFilter[]>([]);
  const setCustom = (next: QuickFilter[]) => {
    customRef.current = next;
    setCustomState(next);
  };
  const [filtersError, setFiltersError] = useState("");
  const [filterBusy, setFilterBusy] = useState(false);
  // Guards re-entry from the latest render, unlike the `filterBusy` state which
  // only reflects the value captured by the current render closure.
  const filterBusyRef = useRef(false);
  const [savingName, setSavingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [searching, setSearching] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    // Wait for the session/CSRF to exist; loading earlier returns 401.
    if (!ready) return;
    let active = true;
    // Quick filters are optional: a failed load only shows a small notice and
    // leaves search fully usable.
    api("/api/live/quick-filters")
      .then((data) => {
        if (!active) return;
        setBuiltin(Array.isArray(data?.builtin) ? data.builtin : []);
        setCustom(Array.isArray(data?.custom) ? data.custom : []);
        setFiltersError("");
      })
      .catch((e) => {
        if (active) setFiltersError(String(e));
      });
    return () => {
      active = false;
    };
    // Reload when the session becomes ready; the parent api identity is
    // recreated every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const search = (q: string, page: number) => {
    // Enter and quick-filter clicks can bypass the disabled button, so guard
    // the request itself until the session and a connection exist.
    if (!ready || !connectionId) return;
    setLastQuery(q);
    const seq = (requestSeq.current += 1);
    setSearching(true);
    return run(async () => {
      try {
        const data = await withTimeout(
          api("/api/live/list", "POST", {
            connectionId,
            filters: { tab: "authored", query: q, page },
          }),
          SEARCH_TIMEOUT_MS,
          "검색 시간 초과 · 다시 시도하세요",
        );
        // Ignore responses from superseded requests.
        if (isLatestRequest(seq, requestSeq.current)) setList(data);
      } finally {
        // Only the newest in-flight request may clear the busy flag.
        if (isLatestRequest(seq, requestSeq.current)) setSearching(false);
      }
    });
  };

  const pickFilter = (f: QuickFilter) => {
    setQuery(f.query);
    search(f.query, 1);
  };

  const applyQuickFilterResponse = (data: any) => {
    if (Array.isArray(data?.custom)) setCustom(data.custom);
    if (Array.isArray(data?.builtin)) setBuiltin(data.builtin);
  };

  const removeFilter = (id: string) => {
    if (filterBusyRef.current) return;
    filterBusyRef.current = true;
    setFilterBusy(true);
    run(async () => {
      try {
        const next = removeQuickFilter(customRef.current, id);
        const data = await api("/api/live/quick-filters", "POST", {
          custom: next,
        });
        applyQuickFilterResponse(data);
      } finally {
        filterBusyRef.current = false;
        setFilterBusy(false);
      }
    });
  };

  const saveFilter = () => {
    if (filterBusyRef.current) return;
    filterBusyRef.current = true;
    setFilterBusy(true);
    run(async () => {
      try {
        const next = planSaveQuickFilter(customRef.current, nameDraft, query);
        const data = await api("/api/live/quick-filters", "POST", {
          custom: next,
        });
        applyQuickFilterResponse(data);
        setSavingName(false);
        setNameDraft("");
      } finally {
        filterBusyRef.current = false;
        setFilterBusy(false);
      }
    });
  };

  const filters = [...builtin, ...custom];
  const items: any[] = Array.isArray(list?.items) ? list.items : [];

  return (
    <section className="pr-search-panel" data-testid="pr-search-panel">
      <h2>인증 사용자 PR 검색</h2>
      <div className="pr-search-row">
        <input
          data-testid="pr-search-query"
          className="pr-search-input"
          aria-label="PR 검색 쿼리"
          spellCheck={false}
          placeholder="is:open review-requested:@me repo:owner/name label:bug"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing)
              search(query, 1);
          }}
        />
        <button
          className="pr-search-button"
          disabled={!canSearch({ ready, connectionId, disabled, searching })}
          onClick={() => search(query, 1)}
        >
          검색
        </button>
      </div>
      {filtersError && (
        <p className="pr-search-error">
          퀵필터를 불러오지 못했습니다: {filtersError}
        </p>
      )}
      <div className="pr-quick-filters" role="toolbar" aria-label="퀵필터">
        {filters.map((f) => (
          <span className="pr-quick-filter-item" key={f.id}>
            <button
              data-testid="pr-quick-filter"
              aria-pressed={query.trim() === f.query}
              onClick={() => pickFilter(f)}
            >
              {f.name}
            </button>
            {!f.builtin && (
              <button
                className="pr-quick-filter-remove"
                aria-label={`${f.name} 퀵필터 삭제`}
                disabled={filterBusy}
                onClick={() => removeFilter(f.id)}
              >
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <div className="pr-search-save">
        {savingName ? (
          <>
            <input
              data-testid="pr-quick-filter-name"
              value={nameDraft}
              placeholder="퀵필터 이름"
              onChange={(e) => setNameDraft(e.target.value)}
            />
            <button
              className="pr-search-button"
              disabled={filterBusy}
              onClick={saveFilter}
            >
              저장
            </button>
            <button
              className="pr-search-button"
              onClick={() => {
                setSavingName(false);
                setNameDraft("");
              }}
            >
              취소
            </button>
          </>
        ) : (
          <button
            className="pr-search-button"
            onClick={() => setSavingName(true)}
          >
            현재 쿼리 저장
          </button>
        )}
      </div>
      <details className="pr-search-help">
        <summary>검색 문법</summary>
        <table>
          <thead>
            <tr>
              <th>한정자</th>
              <th>설명</th>
            </tr>
          </thead>
          <tbody>
            {HELP_ROWS.map(([key, description]) => (
              <tr key={key}>
                <td>
                  <code>{key}</code>
                </td>
                <td>{description}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>is:pr은 자동 추가, 결과는 최근 업데이트 순, 최대 1000건(10페이지)</p>
      </details>
      {list && (
        <div className="pr-search-results" data-testid="pr-search-results">
          <p className="pr-search-summary">
            검색 총계 {list.total} · 현재 페이지 {list.page} · 확보{" "}
            {items.length} · {list.complete ? "페이지 수집 완료" : "부분 목록"}{" "}
            · 남은 API {list.rateRemaining ?? "알 수 없음"}
          </p>
          <p className="pr-search-executed">
            실행 쿼리 <code>{list.query}</code>
          </p>
          {list.limitReason && <p className="notice">{list.limitReason}</p>}
          {items.length === 0 ? (
            <p className="pr-search-empty">결과가 없습니다.</p>
          ) : (
            items.map((p: any) => {
              const meta = [
                p.repository,
                p.author ?? "알 수 없음",
                p.state,
                p.draft ? "draft" : "ready",
                formatUpdated(p.updated_at),
              ]
                .filter(
                  (part) => part !== undefined && part !== null && part !== "",
                )
                .join(" · ");
              return (
                <section className="pr-card" key={p.html_url}>
                  <h3>
                    #{p.number} {p.title}
                  </h3>
                  <p>{meta}</p>
                  <button
                    disabled={disabled}
                    onClick={() => onCapture(p.html_url)}
                  >
                    이 PR 수집
                  </button>
                </section>
              );
            })
          )}
          <button
            className="pr-search-button"
            disabled={searching || list.page <= 1}
            onClick={() => search(lastQuery, list.page - 1)}
          >
            이전 페이지
          </button>
          <button
            className="pr-search-button"
            disabled={searching || !list.hasMore}
            onClick={() => search(lastQuery, list.page + 1)}
          >
            다음 페이지
          </button>
        </div>
      )}
    </section>
  );
}
