import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  updateError,
  updateStageLabel,
  safeUpdateErrorCode,
  UpdateErrorNotice,
} from "../src/update-panel.tsx";

test("updateStageLabel maps each backend stage and rejects unknown ones", () => {
  assert.equal(updateStageLabel("check"), "업데이트 확인 중");
  assert.equal(updateStageLabel("download"), "다운로드 중");
  assert.equal(updateStageLabel("prepare"), "설치 준비(검증) 중");
  assert.equal(updateStageLabel("install"), "설치 중");
  assert.equal(updateStageLabel("cancel"), "취소 처리 중");
  assert.equal(updateStageLabel("preferences"), "설정 저장 중");
  assert.equal(updateStageLabel(undefined), undefined);
  assert.equal(updateStageLabel("unknown"), undefined);
  assert.equal(updateStageLabel(""), undefined);
});

test("UNSAFE_DNS guides DNS/VPN, not folder permissions", () => {
  const text = updateError("UNSAFE_DNS");
  assert.match(text, /DNS/);
  assert.match(text, /VPN/);
  assert.match(text, /DIRECT/);
  assert.doesNotMatch(text, /앱 소유권/);
  assert.doesNotMatch(text, /Finder/);
});

test("DNS, network, timeout, TLS and GitHub codes map to distinct guidance", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "DNS_FAILED"]) {
    assert.match(updateError(code), /DNS 조회에 실패/);
  }
  for (const code of [
    "NETWORK",
    "ECONNRESET",
    "ECONNREFUSED",
    "ENETUNREACH",
    "EHOSTUNREACH",
    "EPIPE",
  ]) {
    assert.match(updateError(code), /업데이트 서버에 연결하지 못했습니다/);
  }
  for (const code of ["TIMEOUT", "ETIMEDOUT"]) {
    assert.match(updateError(code), /제한 시간을 초과/);
  }
  assert.match(updateError("TLS_FAILED"), /인증서/);
  assert.match(updateError("RATE_LIMITED"), /GitHub 요청 한도/);
  assert.match(updateError("HTTP_STATUS"), /GitHub 응답 오류/);
});

test("filesystem codes map to permission and disk-space guidance", () => {
  for (const code of ["EACCES", "EPERM", "EROFS", "PERMISSION_DENIED"]) {
    assert.match(updateError(code), /앱 소유권과 설치 폴더 권한/);
  }
  for (const code of ["ENOSPC", "EDQUOT"]) {
    assert.match(updateError(code), /저장 공간이 부족/);
  }
});

test("legacy BUSY/CANCELLED and verification/helper branches are preserved", () => {
  assert.match(updateError("BUSY"), /분석은 취소되지 않았습니다/);
  assert.match(updateError("CANCELLED"), /업데이트가 취소되었습니다/);
  assert.match(updateError("HASH_MISMATCH"), /검증에 실패했습니다/);
  assert.match(
    updateError("HELPER_START_FAILED"),
    /안전한 설치를 완료하지 못했습니다/,
  );
});

test("compound helper/startup/exit timeout codes keep recovery guidance", () => {
  for (const code of [
    "HELPER_TIMEOUT",
    "STARTUP_TIMEOUT",
    "STARTUP_STOP_TIMEOUT",
    "STARTUP_COMMIT_TIMEOUT",
    "EXIT_TIMEOUT",
  ]) {
    const text = updateError(code);
    assert.match(text, /안전한 설치를 완료하지 못했습니다/);
    assert.doesNotMatch(text, /제한 시간을 초과/);
  }
});

test("exact transport timeout codes still map to timeout guidance", () => {
  for (const code of ["TIMEOUT", "ETIMEDOUT"]) {
    assert.match(updateError(code), /제한 시간을 초과/);
  }
});

test("unclassified failures are not asserted as network problems", () => {
  for (const code of ["UPDATE_FAILED", "SOMETHING_ELSE"]) {
    const text = updateError(code);
    assert.match(text, /원인을 특정하지 못한 실패/);
    assert.doesNotMatch(text, /연결 상태를 확인하고/);
    assert.doesNotMatch(text, /네트워크/);
  }
});

test("safeUpdateErrorCode only allows bounded uppercase codes", () => {
  assert.equal(safeUpdateErrorCode("NETWORK"), "NETWORK");
  assert.equal(safeUpdateErrorCode("UNSAFE_DNS"), "UNSAFE_DNS");
  assert.equal(safeUpdateErrorCode(undefined), undefined);
  assert.equal(safeUpdateErrorCode(""), undefined);
  assert.equal(safeUpdateErrorCode("/Users/me/secret"), "UPDATE_FAILED");
  assert.equal(safeUpdateErrorCode("lowercase"), "UPDATE_FAILED");
  assert.equal(safeUpdateErrorCode("A".repeat(40)), "UPDATE_FAILED");
  assert.equal(
    safeUpdateErrorCode("<script>alert(1)</script>"),
    "UPDATE_FAILED",
  );
});

test("UpdateErrorNotice shows the stage, code and guidance together", () => {
  const html = renderToStaticMarkup(
    React.createElement(UpdateErrorNotice, {
      code: "NETWORK",
      stage: "download",
    }),
  );
  assert.match(html, /다운로드 중 실패/);
  assert.match(html, /NETWORK/);
  assert.match(html, /업데이트 서버에 연결하지 못했습니다/);
});

test("UpdateErrorNotice falls back to a stage-less header for old snapshots", () => {
  const html = renderToStaticMarkup(
    React.createElement(UpdateErrorNotice, { code: "BUSY" }),
  );
  assert.match(html, /업데이트 실패/);
  assert.match(html, /BUSY/);
  assert.doesNotMatch(html, /실패 · <code>BUSY<\/code> 실패/);
});

test("UpdateErrorNotice never renders unvalidated code strings", () => {
  const html = renderToStaticMarkup(
    React.createElement(UpdateErrorNotice, {
      code: "/Users/me/secret — 내부 경로",
      stage: "install",
    }),
  );
  assert.doesNotMatch(html, /Users\/me\/secret/);
  assert.match(html, /UPDATE_FAILED/);
  assert.match(html, /설치 중 실패/);
});

test("UpdateErrorNotice renders nothing when no code is present", () => {
  assert.equal(
    renderToStaticMarkup(
      React.createElement(UpdateErrorNotice, { stage: "check" }),
    ),
    "",
  );
});
