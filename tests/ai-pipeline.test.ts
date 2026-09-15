import test from "node:test";
import assert from "node:assert/strict";
import { runBoundedProcess } from "../src/server/ai/runner.ts";
import {
  createEventParser,
  classifyProviderError,
} from "../src/server/ai/events.ts";

const schema = {
  type: "object",
  properties: { summary: { type: "string" } },
  required: ["summary"],
  additionalProperties: false,
};
test("actual fake process + chunked NDJSON + Ajv integration is not live inference", async () => {
  const events: unknown[] = [];
  const parser = createEventParser("codex", schema, (e) => events.push(e));
  const fake = `let source='';process.stdin.on('data',d=>source+=d);process.stdin.on('end',()=>{console.log(JSON.stringify({type:'thread.started',thread_id:'fake'}));setTimeout(()=>{console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({summary:JSON.parse(source).SOURCE_BUNDLE_JSON.title})}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));},20)});`;
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: ["-e", fake],
    cwd: "/tmp",
    env: {},
    stdin: JSON.stringify({ SOURCE_BUNDLE_JSON: { title: "FAKE FIXTURE" } }),
    deadlineMs: 2000,
    onStdout: (b) => parser.push(b),
  });
  assert.equal(result.exitCode, 0);
  assert.ok(events.length > 0);
  assert.deepEqual(parser.finish().output, { summary: "FAKE FIXTURE" });
});
test("real failing process produces safe normalized auth failure from bounded stderr", async () => {
  const result = await runBoundedProcess({
    executable: process.execPath,
    args: [
      "-e",
      `console.error('401 authentication failed FAKE_SECRET_DO_NOT_EXPOSE');process.exitCode=1`,
    ],
    cwd: "/tmp",
    env: {},
    deadlineMs: 2000,
  });
  assert.equal(result.exitCode, 1);
  const error = classifyProviderError(result.stderr);
  assert.equal(error.code, "auth_invalid");
  assert.equal(error.message.includes("FAKE_SECRET"), false);
});
test("quota event from actual fake process rejects and kills it before completion", async () => {
  const parser = createEventParser("claude", schema);
  await assert.rejects(
    runBoundedProcess({
      executable: process.execPath,
      args: [
        "-e",
        `console.log(JSON.stringify({type:'result',subtype:'error_during_execution',is_error:true,errors:['insufficient_quota']}));setTimeout(()=>{},5000)`,
      ],
      cwd: "/tmp",
      env: {},
      deadlineMs: 2000,
      onStdout: (b) => parser.push(b),
    }),
    { code: "quota_exceeded" },
  );
});
