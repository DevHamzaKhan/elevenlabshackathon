// The people Bobby knows. CONTACTS is `Name=+14155550123,Sam=+14155550124|sam@example.com,Mo=mo@example.com`:
// each value is an E.164 number, an email, or both joined by `|`. More can be learned at run time
// (memory) and, later, read from the phone's contacts.

export type Contact = { name: string; phone?: string; email?: string };

const E164 = /^\+\d{6,15}$/;
const EMAIL = /^[^\s@,|]+@[^\s@,|]+\.[^\s@,|]+$/;

export function parseContactBook(s: string | undefined): Contact[] {
  const out: Contact[] = [];
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    const c: Contact = { name };
    for (const v of part.slice(i + 1).split("|").map((x) => x.trim())) {
      if (E164.test(v)) c.phone = v;
      else if (EMAIL.test(v)) c.email = v;
    }
    if (c.phone || c.email) out.push(c);
  }
  return out;
}

/** Name -> phone, the v1 shape (only contacts with a number). */
export function parseContacts(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of parseContactBook(s)) if (c.phone) out[c.name] = c.phone;
  return out;
}

/** Exact name first, then first name, ignoring case and a trailing possessive. */
export function findContact(book: Contact[], name: string): Contact | null {
  const q = name.trim().toLowerCase().replace(/'s$/, "");
  if (!q) return null;
  const exact = book.find((c) => c.name.toLowerCase() === q);
  if (exact) return exact;
  const first = q.split(/\s+/)[0];
  return book.find((c) => c.name.toLowerCase().split(/\s+/)[0] === first) ?? null;
}

/**
 * A first name in `text` that two or more contacts share, when `text` doesn't say which one
 * ("text Alex" with Alex Chen and Alex Kim). Null when it is clear: a full name was said, or one
 * contact is called just that name.
 */
export function sharedFirstName(book: Contact[], text: string): { first: string; names: string[] } | null {
  const byFirst = new Map<string, Contact[]>();
  for (const c of book) {
    const first = c.name.trim().split(/\s+/)[0].toLowerCase();
    if (first) byFirst.set(first, [...(byFirst.get(first) ?? []), c]);
  }
  for (const [first, group] of byFirst) {
    if (group.length < 2) continue;
    if (!new RegExp(`\\b${escapeRe(first)}(?:'s)?\\b`, "i").test(text)) continue;
    const settled = group.some((c) => c.name.toLowerCase() === first || new RegExp(`\\b${escapeRe(c.name)}\\b`, "i").test(text));
    if (settled) continue;
    return { first: group[0].name.trim().split(/\s+/)[0], names: group.map((c) => c.name) };
  }
  return null;
}

/** If `text` starts with a known contact's name, returns it and the rest of the text. */
export function leadingContact(book: Contact[], text: string): { contact: Contact; rest: string } | null {
  const t = text.trim();
  const sorted = [...book].sort((a, b) => b.name.length - a.name.length);
  // Every full name before any first name: "Sam Lee ..." must not match Sam Park by his first name.
  for (const nameOf of [(c: Contact) => c.name, (c: Contact) => c.name.split(/\s+/)[0]]) {
    for (const c of sorted) {
      const re = new RegExp(`^${escapeRe(nameOf(c))}(?:'s)?\\b[\\s,:]*`, "i");
      const m = re.exec(t);
      if (m) return { contact: c, rest: t.slice(m[0].length) };
    }
  }
  return null;
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
