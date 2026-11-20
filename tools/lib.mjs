// Shared rules for post ideas: how an idea file is read, which text counts as the idea,
// and how alike two ideas are. Used by tools/posts.mjs and the tests.
// No dependencies on purpose: any machine with Node can run it, nothing to install.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STATUSES = ['idea', 'draft', 'approved', 'posted'];

// Channels come from posts.config.json ({"channels": ["LinkedIn", "X", "Threads"]}), LinkedIn
// and X by default. The key is the lowercase name (linkedin, x, threads); a "## LinkedIn"
// heading in an idea file starts that channel's text.
export const CHANNELS = [];
export const CHANNEL_NAMES = {};
const keyOf = (name) => String(name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function useChannels(names) {
  const keys = names.map(keyOf);
  if (!names.length || keys.some((k) => !k) || new Set(keys).size !== keys.length) {
    throw new Error('posts.config.json: "channels" must be a list of different names, like ["LinkedIn", "X"]');
  }
  CHANNELS.splice(0, CHANNELS.length, ...keys);
  for (const k of Object.keys(CHANNEL_NAMES)) delete CHANNEL_NAMES[k];
  names.forEach((n, i) => {
    CHANNEL_NAMES[keys[i]] = String(n).trim();
  });
}
useChannels(['LinkedIn', 'X']);

// The channel key for a typed name or a heading ("Twitter" means X when X is a channel).
export function channelKey(raw) {
  const k = keyOf(raw ?? '');
  if (CHANNELS.includes(k)) return k;
  if (k === 'twitter' && CHANNELS.includes('x')) return 'x';
  return null;
}

// Reads posts.config.json in the repo root; without one, LinkedIn and X.
export function loadConfig(root) {
  const file = join(root, 'posts.config.json');
  if (!existsSync(file)) return useChannels(['LinkedIn', 'X']);
  let config;
  try {
    config = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`posts.config.json is not valid JSON (${e.message})`);
  }
  return useChannels(Array.isArray(config?.channels) ? config.channels : []);
}

// posts/0001-short-title.md: the number is the idea's id, the rest is only for people.
export const FILE_RE = /^(\d{4})-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

// Two ideas scoring at or above ALIKE share most of their words or are a reworded copy.
// They block `add` and `check` until one file lists the other in not_duplicate_of.
// Tuned on the cases in test/posts.test.mjs; raise it if real ideas get flagged wrongly.
export const ALIKE = 0.5;

const STOP = new Set(
  ('a an and are as at be been but by can do for from had has have how i if in into is it its ' +
    'just me more my no not of on one or our out so than that the their them then there these ' +
    'they this to too up us was we were what when which who why will with you your')
    .split(' '),
);

// Lowercase letters and digits only, accents and emoji dropped, links and comments removed.
// Works for any script (Persian, Swedish), because it keeps every Unicode letter.
export function normalize(text) {
  return String(text)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function contentWords(norm) {
  const out = new Set();
  for (let w of norm.split(' ')) {
    if (!w || STOP.has(w)) continue;
    if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.add(w);
  }
  return out;
}

function trigrams(norm) {
  const s = ` ${norm} `;
  const out = new Set();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

function overlap(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  const inter = overlap(a, b);
  return inter / (a.size + b.size - inter);
}

// What the duplicate check compares for one idea: title plus the idea text.
export function fingerprint(text) {
  const norm = normalize(text);
  return { norm, words: contentWords(norm), grams: trigrams(norm) };
}

// 0 = nothing in common, 1 = same words. The highest of three views, so a reworded copy
// (letters), a reordered one (words) and a short idea repeated inside a longer one all count.
export function similarity(fa, fb) {
  if (!fa.norm || !fb.norm) return 0;
  if (fa.norm === fb.norm) return 1;
  const letters = jaccard(fa.grams, fb.grams);
  const words = jaccard(fa.words, fb.words);
  const small = Math.min(fa.words.size, fb.words.size);
  const inside = small >= 6 ? (overlap(fa.words, fb.words) / small) * 0.85 : 0;
  return Math.max(letters, words, inside);
}

function unquote(raw) {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw.slice(1, -1);
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

// The header is a small subset of YAML: `key: value` lines and `key:` followed by
// `  - item` lines. GitHub shows it as a table.
export function parsePost(text) {
  const errors = [];
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const meta = {};
  if (lines[0] !== '---') {
    return { meta, body: lines.join('\n'), errors: ['the file must start with a --- line'] };
  }
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (close < 0) {
    return { meta, body: '', errors: ['the header has no closing --- line'] };
  }
  let listKey = null;
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = line.match(/^\s+-\s*(.*)$/);
    if (item && listKey) {
      meta[listKey].push(unquote(item[1].trim()));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) {
      errors.push(`cannot read the header line "${line.trim()}"`);
      listKey = null;
      continue;
    }
    const [, key, raw] = kv;
    if (key in meta) errors.push(`the header has "${key}" twice`);
    if (raw.trim() === '') {
      meta[key] = [];
      listKey = key;
    } else {
      meta[key] = unquote(raw.trim());
      listKey = null;
    }
  }
  return { meta, body: lines.slice(close + 1).join('\n'), errors };
}

// The body is the idea, then optional `## LinkedIn` and `## X` sections with the version
// for each channel. A channel version never counts as a duplicate of its own idea.
export function splitBody(body) {
  const idea = [];
  const versions = {};
  let current = null;
  for (const line of String(body).split('\n')) {
    const h = line.match(/^##\s+(.+?)\s*$/);
    if (h) {
      const channel = channelKey(h[1]);
      if (channel) {
        current = channel;
        versions[channel] ??= [];
        continue;
      }
      current = null;
    }
    (current ? versions[current] : idea).push(line);
  }
  const clean = (ls) => ls.join('\n').replace(/<!--[\s\S]*?-->/g, '').trim();
  const out = {};
  for (const [k, v] of Object.entries(versions)) out[k] = clean(v);
  return { idea: clean(idea), versions: out };
}

export function listOf(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value ?? '')
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

// A posted line: `linkedin 2026-11-21 https://...` (the link is optional).
export const POSTED_RE = /^(\S+)\s+(\d{4}-\d{2}-\d{2})(?:\s+(https?:\/\/\S+))?$/;
// A scheduled line: `x 2026-11-24 16:00` (local time, the time is optional).
export const SCHEDULED_RE = /^(\S+)\s+(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?$/;

export function loadPosts(root) {
  const dir = join(root, 'posts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md')
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), 'utf8');
      const m = name.match(FILE_RE);
      const { meta, body, errors } = parsePost(text);
      const { idea, versions } = splitBody(body);
      const title = typeof meta.title === 'string' ? meta.title : '';
      return {
        name,
        file: `posts/${name}`,
        id: m ? m[1] : null,
        text,
        meta,
        title,
        idea,
        versions,
        errors,
        print: fingerprint(`${title}\n${idea}`),
      };
    });
}

// Every problem in the folder. errors block a commit, warnings are printed only.
// today (YYYY-MM-DD) turns on the reminder for scheduled dates that have passed.
export function checkPosts(posts, { today } = {}) {
  const errors = [];
  const warnings = [];
  const byId = new Map();
  for (const p of posts) {
    const where = p.file;
    if (!p.id) {
      errors.push(`${where}: the name must look like 0001-short-title.md`);
    } else if (byId.has(p.id)) {
      errors.push(`${where}: number ${p.id} is also used by ${byId.get(p.id).file}, rename one`);
    } else {
      byId.set(p.id, p);
    }
    for (const e of p.errors) errors.push(`${where}: ${e}`);
    if (!p.title) errors.push(`${where}: the header needs a title`);
    if (!p.idea) errors.push(`${where}: write the idea in a line or two under the header`);
    const status = p.meta.status;
    if (!STATUSES.includes(status)) {
      errors.push(`${where}: status must be one of ${STATUSES.join(', ')} (it is "${status ?? ''}")`);
    }
    for (const c of listOf(p.meta.channels)) {
      if (!CHANNELS.includes(c)) errors.push(`${where}: unknown channel "${c}" (use ${CHANNELS.join(', ')})`);
    }
    const posted = listOf(p.meta.posted);
    for (const line of posted) {
      const m = line.match(POSTED_RE);
      if (!m || !CHANNELS.includes(m[1])) {
        errors.push(`${where}: cannot read the posted line "${line}" (write: linkedin 2026-11-21 https://...)`);
      }
    }
    for (const line of listOf(p.meta.scheduled)) {
      const m = line.match(SCHEDULED_RE);
      if (!m || !CHANNELS.includes(m[1])) {
        errors.push(`${where}: cannot read the scheduled line "${line}" (write: x 2026-11-24 16:00)`);
      } else if (today && m[2] < today) {
        warnings.push(
          `${where}: was scheduled on ${m[1]} for ${m[2]}. Once it is live, record it: ` +
            `node tools/posts.mjs posted ${p.id} --channel ${m[1]} --url <link>`,
        );
      }
    }
    if (posted.length && status !== 'posted') warnings.push(`${where}: has posted lines but status is ${status}`);
    if (!posted.length && status === 'posted') {
      warnings.push(`${where}: status is posted but no posted line says where (use the posted command)`);
    }
  }

  const known = (p) => new Set(listOf(p.meta.not_duplicate_of));
  for (let i = 0; i < posts.length; i++) {
    for (let j = i + 1; j < posts.length; j++) {
      const a = posts[i];
      const b = posts[j];
      if (!a.print.norm || !b.print.norm) continue;
      const score = similarity(a.print, b.print);
      if (score === 1) {
        errors.push(`${a.file} and ${b.file}: the same idea twice, keep one`);
      } else if (score >= ALIKE && !known(a).has(b.id) && !known(b).has(a.id)) {
        errors.push(
          `${a.file} and ${b.file}: look alike (${score.toFixed(2)}). Merge them, delete one, ` +
            `or add "not_duplicate_of: ${a.id}" to the header of ${b.file} to keep both`,
        );
      }
      for (const [ca, va] of Object.entries(a.versions)) {
        for (const [cb, vb] of Object.entries(b.versions)) {
          if (va && vb && normalize(va) === normalize(vb)) {
            errors.push(`${a.file} (${ca}) and ${b.file} (${cb}): the same post text twice`);
          }
        }
      }
    }
  }
  return { errors, warnings };
}

// Ideas that match a new one, best first. exact = same words, so keeping both is refused.
export function matches(posts, print) {
  return posts
    .map((p) => ({ post: p, score: similarity(print, p.print) }))
    .filter((m) => m.score >= ALIKE)
    .sort((x, y) => y.score - x.score)
    .map((m) => ({ ...m, exact: m.score === 1 }));
}

export function slugify(title) {
  const s = String(title)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let cut = s.slice(0, 50);
  if (s.length > 50 && cut.includes('-')) cut = cut.slice(0, cut.lastIndexOf('-'));
  return cut.replace(/-+$/g, '') || 'idea';
}

export function nextId(posts) {
  const max = posts.reduce((m, p) => (p.id ? Math.max(m, Number(p.id)) : m), 0);
  return String(max + 1).padStart(4, '0');
}
