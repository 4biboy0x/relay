import test from "node:test";
import assert from "node:assert/strict";
import { containsProfanity } from "./moderation";

test("blocks English and French profanity including common obfuscations", () => {
  for (const value of ["fuck", "f.u.c.k", "fuuuuck", "sh!t", "putain", "pûtaiiin"]) {
    assert.equal(containsProfanity(value), true, value);
  }
});

test("normalizes Arabic diacritics, tatweel and alef variants", () => {
  for (const value of ["كُسْـم", "قحــــبة", "إيري"]) {
    assert.equal(containsProfanity(value), true, value);
  }
});

test("uses complete word boundaries and preserves innocent words", () => {
  for (const value of ["classic", "assistant", "password", "assessment", "hello", "مرحبا", "مكتبة"]) {
    assert.equal(containsProfanity(value), false, value);
  }
});
