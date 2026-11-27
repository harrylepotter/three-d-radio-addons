import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { writeFileSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { apnsSender, widgetNotifications } from "../three_d_radio_likes/widget-push.mjs";

test("pending widget change survives restart and a token change during delivery", async t => {
  const directory = mkdtempSync(join(tmpdir(), "drive-push-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const stateFile = join(directory, "drive-widget.json");
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const tokens = [];
  let finish;
  const original = widgetNotifications(directory, () => assert.fail("No device is registered yet"));
  original.changed();
  const restored = widgetNotifications(directory, async token => {
    tokens.push(token);
    if (tokens.length === 1) await new Promise(resolve => { finish = resolve; });
    return {status:200};
  });
  assert.equal(restored.register("not a token"), false);
  assert.equal(restored.register("aa"), true);
  for (let i = 0; !finish && i < 100; i++) await delay(5);
  assert.ok(finish);
  restored.register("bb");
  restored.changed();
  restored.changed();
  finish();
  for (let i = 0; state().pending && i < 100; i++) await delay(5);
  assert.deepEqual(tokens, ["aa", "bb"]);
  assert.equal(state().pending, false);
  assert.ok(state().delivered);
  assert.equal(statSync(stateFile).mode & 0o777, 0o600);
});

test("a timed-out widget push reconnects, successful pushes reuse the session, and idle sessions retire", async t => {
  const directory = mkdtempSync(join(tmpdir(), "three-d-transport-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const {privateKey} = generateKeyPairSync("ec", {namedCurve:"prime256v1"});
  const credentials = join(directory, "apns.json");
  writeFileSync(credentials, JSON.stringify({keyId:"test", teamId:"test", bundleId:"test.radio",
    privateKey:privateKey.export({type:"pkcs8",format:"pem"})}), {mode:0o600});

  const connections = [];
  function openConnection() {
    const connection = new EventEmitter();
    connections.push(connection);
    connection.setTimeout = (ms, onIdle) => {
      assert.ok(ms > 10000);
      connection.onIdle = onIdle;
    };
    connection.close = () => { connection.closed = true; };
    connection.destroy = () => { connection.destroyed = true; };
    connection.request = () => {
      const request = new PassThrough();
      request.end = () => {
        queueMicrotask(() => {
          if (connections.length === 1) {
            request.destroy(Object.assign(new Error("Timed out"), {code:"ABORT_ERR"}));
          } else {
            request.emit("response", {":status":200});
            request.push(null);
          }
        });
      };
      return request;
    };
    return connection;
  }
  const send = apnsSender(credentials, openConnection);
  await assert.rejects(send("aa"), {code:"ABORT_ERR"});
  assert.equal(connections[0].destroyed, true);
  assert.equal((await send("aa")).status, 200);
  assert.equal((await send("aa")).status, 200);
  assert.equal(connections.length, 2);
  connections[1].onIdle();
  assert.equal((await send("aa")).status, 200);
  assert.equal(connections.length, 3);
});

test("a failed push drains the pending update without opening the phone app or registering again", async t => {
  const directory = mkdtempSync(join(tmpdir(), "three-d-push-retry-"));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  let attempts = 0;
  const notifications = widgetNotifications(directory, async () => {
    if (++attempts === 1) throw Object.assign(new Error("Timed out"), {code:"ABORT_ERR"});
    return {status:200};
  });
  assert.equal(notifications.register("aa"), true);
  notifications.changed();
  const state = () => JSON.parse(readFileSync(join(directory, "drive-widget.json"), "utf8"));
  const deadline = Date.now() + 4000;
  while (state().pending && Date.now() < deadline) await delay(20);
  assert.equal(attempts, 2);
  assert.equal(state().pending, false);
  assert.ok(state().delivered);
});
