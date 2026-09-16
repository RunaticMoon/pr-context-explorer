import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EngineSetupPanel } from "../src/engine-setup-panel.tsx";
test("panel communicates remote transmission and never requests analysis on render", () => {
  let calls = 0;
  const html = renderToStaticMarkup(
    React.createElement(EngineSetupPanel, {
      api: async <T>() => {
        calls++;
        throw new Error("not called");
      },
      ready: true,
      providerId: "codex",
      onProviderChange: () => {},
    }),
  );
  assert.equal(calls, 0);
  assert.match(html, /다시 검색/);
  assert.match(html, /오프라인/);
  assert.match(html, /전송/);
});
