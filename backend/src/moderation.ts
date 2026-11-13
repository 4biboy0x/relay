/**
 * Shared text moderation primitives for public user-generated content.
 * Matching is performed on complete normalized tokens, never substrings.
 */
export const BANNED_WORDS = [
  // English profanity and vulgarities
  "ass", "arse", "asshole", "arsehole", "bastard", "bitch", "biatch",
  "bullshit", "crap", "cunt", "damn", "dick", "dickhead", "dildo",
  "douche", "douchebag", "fag", "faggot", "fuck", "fucker", "fuckers",
  "fucking", "motherfucker", "motherfuckers", "nigger", "nigga", "piss",
  "pissed", "prick", "pussy", "retard", "retarded", "shit", "shitty", "slut", "twat",
  "whore", "wanker", "jackass", "dumbass", " dipshit", "jackhole",
  // French (accents are removed during normalization)
  " putain", "merde", "connard", "connasse", "salope", "pute", "encule",
  "enculer", "enculee", "batard", "fdp", "ntm", "bordel", "con",
  "conne", " salaud", "salopard", " enfoire", " branleur", " branleuse",
  " trouduc", " chiant", " chier", " foutre", " niquer", "nique",
  // Arabic: MSA and commonly used dialectal insults/profanities
  "كس", "كسم", "كسي", "كسك", "قحبة", "قحاب", "شرموط", "شرموطة",
  "شراميط", "متناك", "متناكة", "منيوك", "منيوكة", "نيك", "ينك",
  "ناك", "طيز", "زب", "زبي", "زبر", "قواد", "ديوث", "خول",
  "خنيث", "عرص", "عرصة", "وسخ", "وسخة", "حقير", "حقيرة", "سافل", "سافلة",
  "معرص", "مأحون", "ممحون", "ايري", "اير",
  "يلعن", "لعنة", "خرا", "خراء", "زق", "تفو", "قذر", "قذرة",
  "منيك", "منيوك", "مخنث", "لوطي", "سكس", "كسختك", "كحبة",
] as const;

const normalizeArabic = (value: string): string => value
  .replace(/[\\u064B-\\u065F\\u0670]/g, "")
  .replace(/\\u0640/g, "")
  .replace(/[أإآٱ]/g, "ا");

const normalizeText = (value: string): string => normalizeArabic(value)
  .normalize("NFKD")
  .replace(/[\\u0300-\\u036f]/g, "")
  .toLowerCase()
  .replace(/[@4]/g, "a")
  .replace(/3/g, "e")
  .replace(/[1!]/g, "i")
  .replace(/0/g, "o")
  .replace(/[\\$5]/g, "s")
  .replace(/7/g, "t")
  .replace(/(.)\\1{2,}/gu, "$1")
  .replace(/[\\p{P}\\p{S}]+/gu, "")
  .replace(/\\s+/gu, " ")
  .trim();

const bannedWordSet = new Set(BANNED_WORDS.map((word) => normalizeText(word.trim())));

export const containsProfanity = (text: unknown): boolean => {
  if (typeof text !== "string" || !text) return false;
  const words = normalizeText(text).match(/[\\p{L}\\p{N}]+/gu) ?? [];
  return words.some((word) => bannedWordSet.has(word));
};
