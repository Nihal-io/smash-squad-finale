// Turns a VISIBLE candidate profile into a REDACTED one.
// Removes personal names, college names, pronouns, gendered words and gender proxies.
// Deterministic string replacement, no model involved.

export interface RedactInput {
  text: string;
  names: string[]; // full name, first, last
  colleges: string[];
}

const PRONOUNS: Array<[RegExp, string]> = [
  [/\bhe\b/gi, "they"],
  [/\bshe\b/gi, "they"],
  [/\bhim\b/gi, "them"],
  [/\bhis\b/gi, "their"],
  [/\bhers\b/gi, "theirs"],
  [/\bher\b/gi, "their"],
  [/\bhimself\b/gi, "themself"],
  [/\bherself\b/gi, "themself"],
];

// Gender words and common gender proxies → neutral tokens.
const GENDER_WORDS: Array<[RegExp, string]> = [
  [/\bwomen in tech\b/gi, "[COMMUNITY]"],
  [/\bwomen who code\b/gi, "[COMMUNITY]"],
  [/\bgirls who code\b/gi, "[COMMUNITY]"],
  [/\bsorority\b/gi, "[STUDENT ORG]"],
  [/\bfraternity\b/gi, "[STUDENT ORG]"],
  [/\bwomen's\b/gi, "[GROUP]"],
  [/\bmen's\b/gi, "[GROUP]"],
  [/\b(women|woman|female|females)\b/gi, "[PERSON]"],
  [/\b(men|man|male|males)\b/gi, "[PERSON]"],
  [/\b(girl|girls|boy|boys)\b/gi, "[PERSON]"],
  [/\b(mother|father|mom|dad|wife|husband)\b/gi, "[FAMILY]"],
  [/\b(Mr|Ms|Mrs|Miss)\.?\s/g, ""],
  [/\b(non-binary|nonbinary)\b/gi, "[PERSON]"],
  [/\bmaternity\b/gi, "parental"],
  [/\bpaternity\b/gi, "parental"],
];

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactProfile(input: RedactInput): string {
  let t = input.text;
  // Longest first so "Northfield Institute of Technology" goes before "Northfield".
  const colleges = [...input.colleges].sort((a, b) => b.length - a.length);
  for (const c of colleges) {
    if (!c) continue;
    t = t.replace(new RegExp(escapeRe(c), "gi"), "[COLLEGE]");
  }
  const names = [...input.names].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const n of names) {
    t = t.replace(new RegExp(`\\b${escapeRe(n)}\\b`, "g"), "[CANDIDATE]");
  }
  for (const [re, rep] of GENDER_WORDS) t = t.replace(re, rep);
  for (const [re, rep] of PRONOUNS) {
    t = t.replace(re, (m) => (m[0] === m[0].toUpperCase() ? rep[0].toUpperCase() + rep.slice(1) : rep));
  }
  // Tidy doubled tokens / spacing.
  t = t.replace(/\[CANDIDATE\](\s+\[CANDIDATE\])+/g, "[CANDIDATE]").replace(/[ \t]{2,}/g, " ");
  return t;
}
