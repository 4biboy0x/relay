import test from "node:test";
import assert from "node:assert/strict";
import { containsProfanity } from "./moderation";

test("blocks common English and French profanity including obfuscations", () => {
  for (const value of [
    "ass", "asshole", "bitch", "bastard", "cunt", "dick", "pussy",
    "shit", "bullshit", "fuck", "fucker", "motherfucker", "slut",
    "whore", "nigger", "nigga", "faggot", "retard", "f.u.c.k",
    "fuuuuck", "sh!t", "putain", "pûtaiiin", "merde", "connard",
    "connasse", "salope", "pute", "encule", "batard", "fdp", "ntm",
  ]) {
    assert.equal(containsProfanity(value), true, value);
  }
});

test("normalizes Arabic diacritics, tatweel and alef variants", () => {
  for (const value of [
    "كُسْـم", "قحــــبة", "إيري", "شرمــــوطة", "منيوووك",
    "طيززز", "عرص", "خول",
  ]) {
    assert.equal(containsProfanity(value), true, value);
  }
});

test("uses complete word boundaries and preserves innocent words", () => {
  for (const value of [
    "classic", "assistant", "password", "assessment", "hello",
    "grass", "pass", "compass", "class", "mass", "مرحبا", "مكتبة",
  ]) {
    assert.equal(containsProfanity(value), false, value);
  }
});
