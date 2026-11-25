import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { widgetNotifications } from "../three_d_radio_likes/widget-push.mjs";

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
