// Questions back to the user. A question is one short spoken line plus up to four options that
// Bobby reads out ("Option one: ..."). The first option is the Mind's own pick, so a question
// nobody answers costs nothing: the Mind carries on with what it would have guessed anyway.
// The answer is resolved here, in code, from the user's own words: an option's label ("Kim"),
// an ordinal ("the second one", "option B"), "you pick", "never mind", or free speech, which
// goes back to a model. Pure functions: no hub, no model.

export type Question = { question: string; options: string[] };

/** What came back from the Mouth: the voice model's pick (1-based, 0 = none), its wording, and the raw transcript. */
export type RawAnswer = { option?: number; text?: string; heard?: string };

export type Answer =
  /** One of the options, by 0-based index. */
  | { kind: "option"; index: number; label: string }
  /** Something else: the user's words, for a model to read. */
  | { kind: "free"; text: string }
  /** "Never mind", "neither", "no". */
  | { kind: "cancel" }
  /** Nobody answered. */
  | { kind: "none" };

export const MAX_OPTIONS = 4;

const NUMBER_WORDS = ["one", "two", "three", "four"];
const STOP = new Set(["the", "a", "an", "to", "of", "for", "my", "one", "option", "and", "in", "on", "at", "it", "is", "with", "from", "that", "this", "please"]);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
const tokens = (s: string) => norm(s).split(" ").filter((w) => w && !STOP.has(w));

/** A model's (or code's) question, tidied: at most four distinct short options. Null when there is no question. */
export function cleanQuestion(raw: any): Question | null {
  let question = String(raw?.question ?? "").replace(/\s+/g, " ").trim();
  if (!question) return null;
  if (!/[?.!]$/.test(question)) question += "?";
  const seen = new Set<string>();
  const options: string[] = [];
  for (const o of Array.isArray(raw?.options) ? raw.options : []) {
    const label = String(o ?? "").replace(/\s+/g, " ").trim().replace(/[.;,]+$/, "");
    const key = norm(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    options.push(label);
    if (options.length === MAX_OPTIONS) break;
  }
  return { question, options };
}

/** The line Bobby reads: "Which Alex? Option one: Alex Chen. Option two: Alex Kim." */
export function spokenQuestion(q: Question): string {
  if (q.options.length === 0) return q.question;
  if (q.options.length === 1) return `${q.question} I'd go with ${q.options[0]}.`;
  return `${q.question} ${q.options.map((o, i) => `Option ${NUMBER_WORDS[i]}: ${o}.`).join(" ")}`;
}

const ORDINALS: Record<string, number> = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3 };
const NUMBERS: Record<string, number> = { one: 0, "1": 0, a: 0, two: 1, "2": 1, b: 1, three: 2, "3": 2, c: 2, four: 3, "4": 3, d: 3 };
/** Words people put before a bare pick: "yeah, C works", "go with two". */
const FILLER = new Set(["yeah", "yes", "yep", "yup", "ok", "okay", "uh", "um", "oh", "hmm", "well", "so", "sure", "maybe", "probably", "just", "go", "with", "do", "take", "pick", "choose", "say", "i", "ill", "id", "think", "guess", "lets", "let", "s", "number", "option"]);
/** "not the first one" names an option the user does NOT want. */
const NEGATED = /\b(?:not|isn'?t|except)\s+(?:the\s+|option\s+|number\s+)?\S+(?:\s+one)?/gi;
const CANCEL_RE = /\b(stop|cancel|never ?mind|abort|forget (?:it|that|about it)|leave it|skip it|don'?t bother|neither|none of (?:them|those|these))\b|^\W*(?:no|nope|nah)\W*$/i;
const DEFER_RE =
  /\b(yes|yeah|yep|yup|sure|ok|okay|sounds good|go ahead|that works|works for me|fine|whatever|either|any of them|you (?:pick|choose|decide)|up to you|don'?t (?:mind|care)|doesn'?t matter|your call|the usual|same as (?:last time|before|usual)|go with that)\b/i;
const BUT_RE = /\b(but|instead|actually|except|rather)\b/i;

/**
 * Turns what the user said into an answer. The raw transcript is read first, then the voice
 * model's wording; the voice model's own pick only breaks ties or stands in when the words name
 * no option. Free speech ("oh, you know what you should do...") is passed through untouched.
 */
export function resolveAnswer(q: Question, raw: RawAnswer): Answer {
  const heard = (raw.heard ?? "").trim();
  const text = (raw.text ?? "").trim();
  const said = heard || text;
  const n = q.options.length;
  const voted = Number.isInteger(raw.option) && raw.option! >= 1 && raw.option! <= n ? raw.option! - 1 : -1;
  const option = (i: number): Answer => ({ kind: "option", index: i, label: q.options[i] });
  if (!said) return voted >= 0 ? option(voted) : { kind: "none" };
  if (n > 0) {
    for (const s of heard && text && norm(heard) !== norm(text) ? [heard, text] : [said]) {
      const i = pick(q.options, s, voted);
      if (i >= 0) return option(i);
    }
  }
  const words = norm(said).split(" ").length;
  if (words <= 6 && CANCEL_RE.test(said)) return { kind: "cancel" };
  if (n > 0 && words <= 7 && DEFER_RE.test(said) && !BUT_RE.test(said)) return option(0);
  if (voted >= 0) return option(voted);
  return { kind: "free", text: said };
}

/** The one option `said` points at, or -1. Labels beat explicit ordinals, which beat bare numbers. */
function pick(options: string[], said: string, voted: number): number {
  const n = options.length;
  const flat = norm(said.replace(NEGATED, " "));
  if (!flat) return -1;
  const s = ` ${flat} `;
  const settle = (found: number[]): number => {
    const c = [...new Set(found)].filter((i) => i >= 0 && i < n);
    if (c.length === 1) return c[0];
    return c.includes(voted) ? voted : -1;
  };

  // 1. An option's label: said in full, or by a word no other option has ("Kim", "the work one").
  const labels = options.map(norm);
  let whole = labels.map((l, i) => (l && s.includes(` ${l} `) ? i : -1)).filter((i) => i >= 0);
  whole = whole.filter((i) => !whole.some((j) => j !== i && labels[j].length > labels[i].length && labels[j].includes(labels[i])));
  if (whole.length) return settle(whole);
  const toks = options.map(tokens);
  const byWord = toks.map((t, i) => (t.some((w) => !toks.some((o, j) => j !== i && o.includes(w)) && s.includes(` ${w} `)) ? i : -1)).filter((i) => i >= 0);
  if (byWord.length) return settle(byWord);

  // 2. An explicit ordinal: "the second one", "option B", "number 3", "the last one".
  const explicit: number[] = [];
  for (const m of flat.matchAll(/\b(first|1st|second|2nd|third|3rd|fourth|4th)\b/g)) explicit.push(ORDINALS[m[1]]);
  for (const m of flat.matchAll(/\b(?:option|number|choice|letter)\s+(one|two|three|four|[1-4]|[a-d])\b/g)) explicit.push(NUMBERS[m[1]]);
  if (/\blast\b/.test(flat)) explicit.push(n - 1);
  if (explicit.length) return settle(explicit);

  // 3. A bare number or letter leading a short reply: "two", "yeah, C works".
  const rest = flat.split(" ");
  if (rest.length <= 5) {
    while (rest.length && FILLER.has(rest[0])) rest.shift();
    const first = rest[0] ?? "";
    if (first !== "a" && first in NUMBERS) return settle([NUMBERS[first]]);
  }
  return -1;
}

/** The same question, loosely: used to remember an answer and not ask again. */
export function questionKey(question: string): string {
  return tokens(question).join(" ");
}
