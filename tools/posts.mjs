#!/usr/bin/env node
// Post ideas for your social channels: add one, check for duplicates, list, find, keep
// each channel's text, and record where and when an idea was scheduled and posted.
// Run `node tools/posts.mjs help`.
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHANNELS,
  CHANNEL_NAMES,
  POSTED_RE,
  SCHEDULED_RE,
  STATUSES,
  channelKey,
  checkPosts,
  fingerprint,
  loadConfig,
  listOf,
  loadPosts,
  matches,
  nextId,
  normalize,
  slugify,
} from './lib.mjs';

const HELP = `Post ideas, one file per idea in posts/. Channels: LinkedIn and X, or the list
in posts.config.json ({"channels": ["LinkedIn", "X", "Threads"]}).

  node tools/posts.mjs add --title "Short title" --text "The idea"
  node tools/posts.mjs add --title "Short title" < idea.txt     (text from stdin)
      Adds posts/NNNN-short-title.md with status idea. Refused when the same idea or
      one that looks alike is already there; the match is printed.
      --channels linkedin,x   where it is meant to go (default: every channel)
      --keep-both 0003,0007   it is a new idea after all: keep it next to those
      --dry-run               only check, write nothing
      --source "..." --note "..."   where it came from, anything to remember

  node tools/posts.mjs version 12 --channel linkedin < post.txt   (or --text "...")
      Saves or replaces that channel's post text in the idea, word for word. Refused when the
      same text is already in another idea. Sets status draft if it was idea.
  node tools/posts.mjs unschedule 12 --channel linkedin [--drop] [--note "Not for LinkedIn"]
      Takes it off that channel's schedule; --drop also takes the channel out of channels.

  node tools/posts.mjs check                every file valid, no duplicates (the commit hook runs this)
  node tools/posts.mjs list [--status S]     all ideas, or only one status (${STATUSES.join(', ')})
  node tools/posts.mjs find some words       ideas that mention these words, best first
  node tools/posts.mjs schedule 12 --channel x --date 2026-11-24 [--time 16:00]
      Notes that it is scheduled on that channel (your local time) and sets status approved.
      Scheduling it again on the same channel moves it. check reminds you once the date passed.
  node tools/posts.mjs posted 12 --channel linkedin --url https://... [--date 2026-11-21] [--repost]
      Records where an idea went out, clears its scheduled line for that channel, and sets
      status posted. A second post on the same channel is refused unless --repost.

Exit code 0 = fine, 1 = refused or problems found, 2 = wrong command.`;

const VALUE_OPTS = new Set([
  'title', 'text', 'channels', 'keep-both', 'status', 'channel', 'url', 'date', 'time', 'root', 'source', 'note',
]);
const FLAG_OPTS = new Set(['dry-run', 'repost', 'drop', 'help']);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      rest.push(a);
      continue;
    }
    const [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTS.has(key)) {
      opts[key] = true;
    } else if (VALUE_OPTS.has(key)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${key} needs a value`);
      opts[key] = value;
    } else {
      throw new UsageError(`unknown option --${key}`);
    }
  }
  return { cmd: rest[0], args: rest.slice(1), opts };
}

const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD in the machine's own time zone

function toId(raw) {
  if (!/^\d{1,4}$/.test(String(raw ?? ''))) throw new UsageError(`"${raw ?? ''}" is not an idea number`);
  return String(raw).padStart(4, '0');
}

function channelOf(raw) {
  const c = channelKey(raw);
  if (!c) throw new UsageError(`channel must be one of ${CHANNELS.join(', ')}`);
  return c;
}

function readText(opts, stdin) {
  if (opts.text !== undefined) return opts.text;
  if (stdin !== undefined) return stdin;
  const none = new UsageError('give the idea with --text "..." or on stdin');
  if (process.stdin.isTTY) throw none;
  try {
    return readFileSync(0, 'utf8');
  } catch (e) {
    // A pipe with nothing written to it (EAGAIN) or a closed stdin: no idea was given.
    if (['EAGAIN', 'EOF', 'EBADF'].includes(e.code)) throw none;
    throw e;
  }
}

function shortTitle(text) {
  const first = text.split('\n').find((l) => l.trim()) ?? '';
  const line = first.trim();
  if (line.length <= 70) return line;
  const cut = line.slice(0, 70);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 70).trim()}...`;
}

function describe(post) {
  return `${post.id ?? '????'} "${post.title}" (${post.file}, ${post.meta.status ?? 'no status'})`;
}

function add(root, opts, out, stdin) {
  const text = readText(opts, stdin).replace(/\r\n?/g, '\n').trim();
  if (!text) throw new UsageError('the idea text is empty');
  const title = (opts.title ?? shortTitle(text)).trim();
  if (!title) throw new UsageError('the title is empty');
  const channels = opts.channels === undefined ? CHANNELS : listOf(opts.channels).map(channelOf);
  const posts = loadPosts(root);
  const ids = new Set(posts.map((p) => p.id));
  const keepBoth = opts['keep-both'] === undefined ? [] : listOf(opts['keep-both']).map(toId);
  for (const id of keepBoth) if (!ids.has(id)) throw new UsageError(`--keep-both ${id}: there is no idea ${id}`);

  const textNorm = normalize(text);
  const sameVersion = posts.find((p) => Object.values(p.versions).some((v) => v && normalize(v) === textNorm));
  const found = matches(posts, fingerprint(`${title}\n${text}`));
  const exact = found.find((m) => m.exact)?.post ?? sameVersion;
  if (exact) {
    out.push(`Already in the repo: ${describe(exact)}. Nothing added.`);
    out.push('Edit that file if this is a new angle on it.');
    return 1;
  }
  const open = found.filter((m) => !keepBoth.includes(m.post.id));
  if (open.length) {
    out.push('Looks like an idea that is already in the repo. Nothing added.');
    for (const m of open) out.push(`  ${m.score.toFixed(2)}  ${describe(m.post)}`);
    out.push('Merge it into that file, drop it, or, if it is really a new idea, run again with');
    out.push(`  --keep-both ${open.map((m) => m.post.id).join(',')}`);
    return 1;
  }

  const id = nextId(posts);
  const file = `posts/${id}-${slugify(title)}.md`;
  if (opts['dry-run']) {
    out.push(`New idea, no match in ${posts.length} ideas. Would write ${file}.`);
    return 0;
  }
  const header = [
    '---',
    `title: ${JSON.stringify(title)}`,
    'status: idea',
    `created: ${today()}`,
    `channels: ${channels.join(', ')}`,
    ...(keepBoth.length ? [`not_duplicate_of: ${keepBoth.join(', ')}`] : []),
    ...(opts.source ? [`source: ${JSON.stringify(opts.source)}`] : []),
    ...(opts.note ? [`note: ${JSON.stringify(opts.note)}`] : []),
    '---',
  ];
  const sections = channels.flatMap((c) => ['', `## ${CHANNEL_NAMES[c]}`]);
  mkdirSync(join(root, 'posts'), { recursive: true });
  writeFileSync(join(root, file), `${[...header, '', text, ...sections].join('\n')}\n`, { flag: 'wx' });
  out.push(`Added ${file}`);
  return 0;
}

function check(root, out) {
  const posts = loadPosts(root);
  if (!posts.length) {
    out.push('No ideas yet.');
    return 0;
  }
  const { errors, warnings } = checkPosts(posts, { today: today() });
  for (const w of warnings) out.push(`warning: ${w}`);
  for (const e of errors) out.push(`error: ${e}`);
  if (errors.length) {
    out.push(`${posts.length} ideas checked, ${errors.length} problem${errors.length === 1 ? '' : 's'}.`);
    return 1;
  }
  out.push(`${posts.length} ideas checked, no duplicates.`);
  return 0;
}

function postedLines(post) {
  return listOf(post.meta.posted)
    .map((l) => l.match(POSTED_RE))
    .filter(Boolean)
    .map(([, channel, date, url]) => ({ channel, date, url }));
}

function list(root, opts, out) {
  if (opts.status !== undefined && !STATUSES.includes(opts.status)) {
    throw new UsageError(`status must be one of ${STATUSES.join(', ')}`);
  }
  const posts = loadPosts(root).filter((p) => opts.status === undefined || p.meta.status === opts.status);
  for (const p of posts) {
    const done = postedLines(p).map((x) => `${x.channel} ${x.date}`);
    const next = scheduledLines(p).map((x) => `${x.channel} ${x.date}`);
    const channels = listOf(p.meta.channels).join(',') || '-';
    out.push(
      `${p.id ?? '????'}  ${String(p.meta.status ?? '?').padEnd(8)}  ${channels.padEnd(10)}  ${p.title}` +
        (done.length ? `  [posted: ${done.join(', ')}]` : '') +
        (next.length ? `  [scheduled: ${next.join(', ')}]` : ''),
    );
  }
  const counts = STATUSES.map((s) => `${posts.filter((p) => p.meta.status === s).length} ${s}`);
  out.push(`${posts.length} idea${posts.length === 1 ? '' : 's'}${opts.status ? '' : `: ${counts.join(', ')}`}`);
  return 0;
}

function find(root, args, out) {
  const query = args.join(' ').trim();
  if (!query) throw new UsageError('find needs some words');
  const q = fingerprint(query);
  const qWords = [...q.words];
  const scored = loadPosts(root)
    .map((p) => {
      const hay = fingerprint(`${p.title}\n${p.idea}\n${Object.values(p.versions).join('\n')}`);
      const hits = qWords.filter((w) => [...hay.words].some((h) => h === w || (w.length >= 3 && h.startsWith(w))));
      return { p, score: qWords.length ? hits.length / qWords.length : 0 };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name))
    .slice(0, 10);
  if (!scored.length) out.push(`Nothing mentions "${query}".`);
  for (const s of scored) out.push(`${s.score.toFixed(2)}  ${describe(s.p)}`);
  return 0;
}

// Header edits keep every other line of the file exactly as it was.
function splitFile(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return { header: lines.slice(1, close), rest: lines.slice(close) };
}
const joinFile = ({ header, rest }) => ['---', ...header, ...rest].join('\n');

// The [at, end) lines of a list key; an inline value (`key: one item`) becomes a list first.
function listBlock(header, key) {
  const at = header.findIndex((l) => l.startsWith(`${key}:`));
  if (at < 0) return null;
  const inline = header[at].slice(key.length + 1).trim();
  if (inline) header.splice(at, 1, `${key}:`, `  - ${inline}`);
  const end = header.findIndex((l, i) => i > at && !/^\s+-/.test(l));
  return { at, end: end < 0 ? header.length : end };
}

function addItem(header, key, item) {
  const b = listBlock(header, key);
  if (b) header.splice(b.end, 0, `  - ${item}`);
  else header.push(`${key}:`, `  - ${item}`);
}

// Removes the first item that passes test and returns it; drops the key when its list is empty.
function removeItem(header, key, test) {
  const b = listBlock(header, key);
  if (!b) return null;
  for (let i = b.at + 1; i < b.end; i++) {
    const value = header[i].replace(/^\s+-\s*/, '').trim();
    if (!test(value)) continue;
    header.splice(i, 1);
    if (b.end - b.at === 2) header.splice(b.at, 1);
    return value;
  }
  return null;
}

function setStatus(header, status) {
  const s = header.findIndex((l) => /^status:/.test(l));
  if (s < 0) header.push(`status: ${status}`);
  else header[s] = `status: ${status}`;
}

function scheduledLines(post) {
  return listOf(post.meta.scheduled)
    .map((l) => l.match(SCHEDULED_RE))
    .filter(Boolean)
    .map(([, channel, date, time]) => ({ channel, date, time }));
}

function findPost(root, rawId, out) {
  const id = toId(rawId);
  const post = loadPosts(root).find((p) => p.id === id);
  if (!post) throw new UsageError(`there is no idea ${id}`);
  if (post.errors.length) {
    out.push(`${post.file} has a header problem, fix it first: ${post.errors.join('; ')}`);
    return null;
  }
  return post;
}

function dateOpt(opts) {
  const date = opts.date ?? today();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new UsageError('--date must look like 2026-11-21');
  return date;
}

function posted(root, args, opts, out) {
  const channel = channelOf(opts.channel);
  const date = dateOpt(opts);
  if (opts.url !== undefined && !/^https?:\/\/\S+$/.test(opts.url)) throw new UsageError('--url must be a link');
  const post = findPost(root, args[0], out);
  if (!post) return 1;
  const before = postedLines(post).filter((x) => x.channel === channel);
  if (before.length && !opts.repost) {
    const last = before[before.length - 1];
    out.push(`${post.id} is already on ${channel} (${last.date}${last.url ? ` ${last.url}` : ''}). Nothing recorded.`);
    out.push('Run again with --repost to post it again on purpose.');
    return 1;
  }
  const file = splitFile(post.text);
  addItem(file.header, 'posted', [channel, date, opts.url].filter(Boolean).join(' '));
  const was = removeItem(file.header, 'scheduled', (v) => v.split(/\s+/)[0] === channel);
  setStatus(file.header, 'posted');
  writeFileSync(join(root, post.file), joinFile(file));
  out.push(`Recorded: ${post.id} on ${channel} ${date}${opts.url ? ` ${opts.url}` : ''}${was ? ` (was scheduled ${was})` : ''}`);
  return 0;
}

function setNote(header, post, text) {
  const note = [typeof post.meta.note === 'string' ? post.meta.note : '', text].filter(Boolean).join(' ');
  const at = header.findIndex((l) => /^note:/.test(l));
  if (at < 0) header.push(`note: ${JSON.stringify(note)}`);
  else header[at] = `note: ${JSON.stringify(note)}`;
}

function setChannels(header, channels) {
  const at = header.findIndex((l) => /^channels:/.test(l));
  const line = `channels: ${channels.join(', ')}`;
  if (at < 0) header.push(line);
  else header[at] = line;
}

const isHeading = (line, channel) => {
  const m = line.match(/^##\s+(.+?)\s*$/);
  return m ? channelKey(m[1]) === channel : false;
};

// Saves (or replaces) one channel's post text in the idea file.
function version(root, args, opts, out, stdin) {
  const channel = channelOf(opts.channel);
  const text = readText(opts, stdin).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (!text) throw new UsageError('the post text is empty');
  if (/^##\s/m.test(text)) throw new UsageError('the post text has a line starting with "## ", which would split the file');
  const posts = loadPosts(root);
  const post = findPost(root, args[0], out);
  if (!post) return 1;
  const norm = normalize(text);
  const twin = posts.find((p) => p.id !== post.id && Object.values(p.versions).some((v) => v && normalize(v) === norm));
  if (twin) {
    out.push(`The same post text is already in ${describe(twin)}. Nothing saved.`);
    return 1;
  }
  const file = splitFile(post.text);
  const body = file.rest.slice(1);
  const h = body.findIndex((l) => isHeading(l, channel));
  let next;
  if (h < 0) {
    next = [...body.join('\n').trimEnd().split('\n'), '', `## ${CHANNEL_NAMES[channel]}`, '', text, ''];
  } else {
    let end = body.findIndex((l, i) => i > h && /^##\s/.test(l));
    if (end < 0) end = body.length;
    const tail = body.slice(end);
    next = [...body.slice(0, h + 1), '', text, '', ...tail];
  }
  file.rest = [file.rest[0], ...next.join('\n').replace(/\n+$/, '\n').split('\n')];
  const channels = listOf(post.meta.channels);
  if (!channels.includes(channel)) setChannels(file.header, [...channels, channel]);
  if (post.meta.status === 'idea') setStatus(file.header, 'draft');
  writeFileSync(join(root, post.file), joinFile(file));
  out.push(`Saved the ${CHANNEL_NAMES[channel]} version of ${post.id} (${text.length} characters).`);
  return 0;
}

// Takes an idea off a channel's schedule; --drop also takes the channel out of channels.
function unschedule(root, args, opts, out) {
  const channel = channelOf(opts.channel);
  const post = findPost(root, args[0], out);
  if (!post) return 1;
  const file = splitFile(post.text);
  const was = removeItem(file.header, 'scheduled', (v) => v.split(/\s+/)[0] === channel);
  if (!was && !opts.drop) {
    out.push(`${post.id} is not scheduled on ${channel}. Nothing changed.`);
    return 1;
  }
  if (opts.drop) setChannels(file.header, listOf(post.meta.channels).filter((c) => c !== channel));
  if (opts.note) setNote(file.header, post, opts.note);
  writeFileSync(join(root, post.file), joinFile(file));
  out.push(
    `${post.id}: ${was ? `removed the ${channel} slot (${was.split(/\s+/).slice(1).join(' ')})` : 'not scheduled'}` +
      `${opts.drop ? `, ${channel} taken out of channels` : ''}.`,
  );
  return 0;
}

function schedule(root, args, opts, out) {
  const channel = channelOf(opts.channel);
  if (opts.date === undefined) throw new UsageError('schedule needs --date');
  const date = dateOpt(opts);
  if (opts.time !== undefined && !/^\d{1,2}:\d{2}$/.test(opts.time)) throw new UsageError('--time must look like 16:00');
  const post = findPost(root, args[0], out);
  if (!post) return 1;
  if (postedLines(post).some((x) => x.channel === channel) && !opts.repost) {
    out.push(`${post.id} is already posted on ${channel}. Nothing scheduled. Add --repost to post it again on purpose.`);
    return 1;
  }
  const file = splitFile(post.text);
  const was = removeItem(file.header, 'scheduled', (v) => v.split(/\s+/)[0] === channel);
  addItem(file.header, 'scheduled', [channel, date, opts.time].filter(Boolean).join(' '));
  if (['idea', 'draft'].includes(post.meta.status)) setStatus(file.header, 'approved');
  writeFileSync(join(root, post.file), joinFile(file));
  const when = `${date}${opts.time ? ` ${opts.time}` : ''}`;
  out.push(`Scheduled: ${post.id} on ${channel} ${when}${was ? ` (moved from ${was.split(/\s+/).slice(1).join(' ')})` : ''}`);
  return 0;
}

// stdin: the idea text when it does not come from --text (tests pass it; the command line reads fd 0).
export function run(argv, { root: defaultRoot, stdin } = {}) {
  const out = [];
  try {
    const { cmd, args, opts } = parseArgs(argv);
    const root = opts.root ?? defaultRoot;
    if (!cmd || cmd === 'help' || opts.help) {
      out.push(HELP);
      return { code: cmd || opts.help ? 0 : 2, out };
    }
    try {
      loadConfig(root);
    } catch (e) {
      throw new UsageError(e.message);
    }
    const code =
      cmd === 'add' ? add(root, opts, out, stdin)
      : cmd === 'check' ? check(root, out)
      : cmd === 'list' ? list(root, opts, out)
      : cmd === 'find' ? find(root, args, out)
      : cmd === 'posted' ? posted(root, args, opts, out)
      : cmd === 'schedule' ? schedule(root, args, opts, out)
      : cmd === 'unschedule' ? unschedule(root, args, opts, out)
      : cmd === 'version' ? version(root, args, opts, out, stdin)
      : null;
    if (code === null) throw new UsageError(`unknown command "${cmd}" (try: help)`);
    return { code, out };
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    out.push(`${e.message}. Run: node tools/posts.mjs help`);
    return { code: 2, out };
  }
}

// realpath on both sides: on macOS the temp folder is a symlink, and a plain compare
// silently skips main() when the script is started through one.
const self = realpathSync(fileURLToPath(import.meta.url));
if (process.argv[1] && realpathSync(process.argv[1]) === self) {
  const { code, out } = run(process.argv.slice(2), { root: dirname(dirname(self)) });
  if (out.length) (code === 0 ? console.log : console.error)(out.join('\n'));
  process.exitCode = code;
}
