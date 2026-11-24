// What the Mind remembers across sessions: facts, learned contacts, task outcomes and recipes.
// Persisted through an injected key-value store (AsyncStorage/SecureStore in the app, in-memory in
// tests). No package reads files at run time; the store is the only door.

import type { Contact } from "./contacts";

/** The storage the app injects. Shaped like AsyncStorage, so it can be passed as is. */
export type KeyValueStore = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

export class InMemoryStore implements KeyValueStore {
  data = new Map<string, string>();
  async getItem(k: string) {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  async setItem(k: string, v: string) {
    this.data.set(k, v);
  }
}

export type Outcome = { task: string; title: string; status: string; line: string; at: number };

const KEY = "bobby-mind/memory/v1";
const MAX_FACTS = 40;
const MAX_OUTCOMES = 30;

type Saved = { facts: string[]; contacts: Contact[]; outcomes: Outcome[]; recipes: unknown[] };

export class Memory {
  facts: string[] = [];
  contacts: Contact[] = [];
  outcomes: Outcome[] = [];
  /** Raw recipe records; recipes.ts owns their shape. */
  recipes: unknown[] = [];
  private saving: Promise<void> = Promise.resolve();
  private dirty = false;
  loaded: Promise<void>;

  constructor(
    private store: KeyValueStore,
    private log: (l: string) => void = () => {},
  ) {
    this.loaded = this.load();
  }

  private async load() {
    try {
      const raw = await this.store.getItem(KEY);
      if (!raw) return;
      const s = JSON.parse(raw) as Partial<Saved>;
      this.facts = Array.isArray(s.facts) ? s.facts.slice(-MAX_FACTS) : [];
      this.contacts = Array.isArray(s.contacts) ? s.contacts : [];
      this.outcomes = Array.isArray(s.outcomes) ? s.outcomes.slice(-MAX_OUTCOMES) : [];
      this.recipes = Array.isArray(s.recipes) ? s.recipes : [];
      this.log(`memory: loaded ${this.facts.length} facts, ${this.outcomes.length} outcomes, ${this.recipes.length} recipes`);
    } catch (e) {
      this.log(`memory: load failed (${String(e)}); starting empty`);
    }
  }

  addFact(f: string) {
    if (!f.trim()) return;
    this.facts.push(f.trim());
    if (this.facts.length > MAX_FACTS) this.facts.splice(0, this.facts.length - MAX_FACTS);
    this.save();
  }

  addOutcome(o: Outcome) {
    this.outcomes.push(o);
    if (this.outcomes.length > MAX_OUTCOMES) this.outcomes.splice(0, this.outcomes.length - MAX_OUTCOMES);
    this.save();
  }

  /** Writes are coalesced: at most one in flight, the latest state wins. */
  save() {
    this.dirty = true;
    this.saving = this.saving.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const s: Saved = { facts: this.facts, contacts: this.contacts, outcomes: this.outcomes, recipes: this.recipes };
      try {
        await this.store.setItem(KEY, JSON.stringify(s));
      } catch (e) {
        this.log(`memory: save failed: ${String(e)}`);
      }
    });
  }

  flush(): Promise<void> {
    return this.saving;
  }
}
