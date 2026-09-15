import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import {
  startEgressProxy,
  allowedAuthority,
  publicIPv4,
} from "../src/server/ai/egress.ts";

test("egress authorities match only exact selected provider TLS hosts", () => {
  assert.equal(
    allowedAuthority("codex", "api.openai.com:443"),
    "api.openai.com",
  );
  for (const value of [
    "api.openai.com.evil.test:443",
    "api.openai.com:80",
    "127.0.0.1:443",
    "169.254.169.254:443",
    "api.anthropic.com:443",
    "user@api.openai.com:443",
    "api.openai.com.:443",
  ])
    assert.equal(allowedAuthority("codex", value), null);
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "::1",
  ])
    assert.equal(publicIPv4(ip), false);
  assert.equal(publicIPv4("1.1.1.1"), true);
});
// Independent expected boundaries from IANA special-purpose IPv4 + multicast.
for (const [first, last] of [
  ["0.0.0.0", "0.255.255.255"],
  ["10.0.0.0", "10.255.255.255"],
  ["100.64.0.0", "100.127.255.255"],
  ["127.0.0.0", "127.255.255.255"],
  ["169.254.0.0", "169.254.255.255"],
  ["172.16.0.0", "172.31.255.255"],
  ["192.0.0.0", "192.0.0.255"],
  ["192.0.2.0", "192.0.2.255"],
  ["192.88.99.0", "192.88.99.255"],
  ["192.168.0.0", "192.168.255.255"],
  ["198.18.0.0", "198.19.255.255"],
  ["198.51.100.0", "198.51.100.255"],
  ["203.0.113.0", "203.0.113.255"],
  ["224.0.0.0", "239.255.255.255"],
  ["240.0.0.0", "255.255.255.255"],
]) {
  test(`special-purpose egress boundaries ${first} to ${last}`, () => {
    assert.equal(publicIPv4(first), false);
    assert.equal(publicIPv4(last), false);
  });
}
test("deprecated relay prefix denies every address without blocking adjacent ordinary IPv4", () => {
  for (let n = 0; n < 256; n++)
    assert.equal(publicIPv4(`192.88.99.${n}`), false);
  assert.equal(publicIPv4("192.88.98.255"), true);
  assert.equal(publicIPv4("192.88.100.0"), true);
  for (const value of [
    "192.088.99.1",
    "192.88.99.1:443",
    "::ffff:192.88.99.1",
    "3227017985",
    "192.88.99.1 ",
  ])
    assert.equal(publicIPv4(value), false);
});

test("real Unix socket egress proxy rejects arbitrary destinations without DNS", async () => {
  const dir = await mkdtemp("/tmp/ai-egress-test-");
  const proxy = await startEgressProxy("codex", `${dir}/egress.sock`);
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(`${dir}/egress.sock`);
      let data = "";
      socket.on("connect", () =>
        socket.end(
          "CONNECT attacker.invalid:443 HTTP/1.1\r\nHost: attacker.invalid\r\n\r\n",
        ),
      );
      socket.on("data", (d) => (data += d));
      socket.on("end", () => resolve(data));
      socket.on("error", reject);
    });
    assert.match(reply, /403/);
  } finally {
    await proxy.close();
    await rm(dir, { recursive: true, force: true });
  }
});
