/**
 * Shared text moderation primitives for public user-generated content.
 * Matching is performed on complete normalized tokens, never substrings.
 */
export const BANNED_WORDS = [
  // English
  "fuck", "shit", "bitch", "asshole", "bastard", "dick", "cunt",
  "motherfucker", "bullshit",
  // French (accents are removed during normalization)
  "putain", "merde", "connard", "connasse", "salope", "encule", "bordel",
  // Arabic
  "كس", "كسم", "قحبة", "شرموط", "شرموطة", "متناك", "منيوك",
  "خول", "طيز", "زب", "ايري",
] as const;

const normalizeArabic = (value: string): string => value
  .replace(/[\u064B-\u065F\u0670]/g, "")
  .replace(/\u0640/g, "")
  .replace(/[أإآٱ]/g, "ا");

const normalizeText = (value: string): string => normalizeArabic(value)
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[@4]/g, "a")
  .replace(/3/g, "e")
  .replace(/[1!]/g, "i")
  .replace(/0/g, "o")
  .replace(/[\$5]/g, "s")
  .replace(/7/g, "t")
  .replace(/(.)\1{2,}/gu, "$1")
  .replace(/[\p{P}\p{S}]+/gu, "")
  .replace(/\s+/gu, " ")
  .trim();

const bannedWordSet = new Set(BANNED_WORDS.map(normalizeText));

export const containsProfanity = (text: unknown): boolean => {
  if (typeof text !== "string" || !text) return false;
  const words = normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => bannedWordSet.has(word));
};
