import assert from "node:assert/strict";
import test from "node:test";

import { PACKAGE_NAME } from "../src/index.ts";

test("smoke: package name is defined", () => {
  assert.equal(PACKAGE_NAME, "@agencyhq/verification");
});
