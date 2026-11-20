import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ALIKE, fingerprint, similarity } from '../tools/lib.mjs';
import { run } from '../tools/posts.mjs';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const dirs = [];

// Every temp folder is removed after its test, also when the test fails.
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'posts-as-code-'));
  dirs.push(root);
  mkdirSync(join(root, 'posts'));
  return root;
}

const cli = (root, ...argv) => {
  const { code, out } = run([...argv, '--root', root], { stdin: '' });
  return { code, text: out.join('\n') };
};
const files = (root) => readdirSync(join(root, 'posts')).filter((n) => n.endsWith('.md')).sort();
const read = (root, name) => readFileSync(join(root, 'posts', name), 'utf8');
const write = (root, name, text) => writeFileSync(join(root, 'posts', name), text);

const post = ({ title, status = 'idea', extra = '', body }) =>
  `---\ntitle: "${title}"\nstatus: ${status}\ncreated: 2026-11-20\nchannels: linkedin, x\n${extra}---\n\n${body}\n`;

test('add writes one file per idea and check passes', () => {
  const root = tempRoot();
  const r = cli(root, 'add', '--title', 'One engine for all my apps', '--text', 'Why I run one marketing engine instead of a team per app.');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Added posts\/0001-one-engine-for-all-my-apps\.md/);
  const text = read(root, '0001-one-engine-for-all-my-apps.md');
  assert.match(text, /^---\ntitle: "One engine for all my apps"\nstatus: idea\ncreated: \d{4}-\d{2}-\d{2}\nchannels: linkedin, x\n---\n/);
  assert.match(text, /\n## LinkedIn\n\n## X\n$/);
  assert.equal(cli(root, 'check').code, 0);
});

test('the same idea again is refused, even with --keep-both', () => {
  const root = tempRoot();
  cli(root, 'add', '--title', 'One engine for all my apps', '--text', 'Why I run one marketing engine instead of a team per app.');
  const again = cli(root, 'add', '--title', 'ONE engine for all my apps!', '--text', 'why I run one marketing engine, instead of a team per app. https://example.com');
  assert.equal(again.code, 1);
  assert.match(again.text, /Already in the repo: 0001/);
  assert.equal(cli(root, 'add', '--title', 'One engine for all my apps', '--text', 'Why I run one marketing engine instead of a team per app.', '--keep-both', '1').code, 1);
  assert.deepEqual(files(root), ['0001-one-engine-for-all-my-apps.md']);
});

test('a reworded idea is refused until you say keep both', () => {
  const root = tempRoot();
  cli(root, 'add', '--text', 'Shipping a side project alone: what I learned about saying no to features.');
  const r = cli(root, 'add', '--text', 'What shipping a side project alone taught me about saying no to features.');
  assert.equal(r.code, 1);
  assert.match(r.text, /Looks like an idea that is already in the repo/);
  assert.match(r.text, /--keep-both 0001/);
  assert.equal(files(root).length, 1);

  const kept = cli(root, 'add', '--text', 'What shipping a side project alone taught me about saying no to features.', '--keep-both', '0001');
  assert.equal(kept.code, 0, kept.text);
  assert.match(read(root, files(root)[1]), /\nnot_duplicate_of: 0001\n/);
  assert.equal(cli(root, 'check').code, 0);
});

test('different ideas on the same topic go in, numbered in order', () => {
  const root = tempRoot();
  assert.equal(cli(root, 'add', '--text', 'How I use Claude agents as a marketing team for my apps.').code, 0);
  assert.equal(cli(root, 'add', '--text', 'How I use Claude to review my pull requests before I merge them.').code, 0);
  assert.equal(cli(root, 'add', '--text', 'Moving to a new country as a software engineer: the first year.', '--channels', 'linkedin').code, 0);
  assert.deepEqual(files(root).map((n) => n.slice(0, 4)), ['0001', '0002', '0003']);
  assert.doesNotMatch(read(root, files(root)[2]), /## X/);
  assert.equal(cli(root, 'check').code, 0);
});

test('--dry-run checks and writes nothing', () => {
  const root = tempRoot();
  const r = cli(root, 'add', '--text', 'A brand new thought.', '--dry-run');
  assert.equal(r.code, 0);
  assert.match(r.text, /Would write posts\/0001-a-brand-new-thought\.md/);
  assert.deepEqual(files(root), []);
});

test('check catches duplicates made by hand, and not_duplicate_of clears an alike pair', () => {
  const root = tempRoot();
  write(root, '0001-engine.md', post({ title: 'One engine', body: 'Why I run one marketing engine for all my apps.' }));
  write(root, '0002-engine-copy.md', post({ title: 'One engine', body: 'Why I run one marketing engine for all my apps!' }));
  let r = cli(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.text, /the same idea twice/);

  write(root, '0002-engine-copy.md', post({ title: 'One engine', body: 'Why I built one marketing engine for all my apps.' }));
  r = cli(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.text, /look alike/);
  assert.match(r.text, /not_duplicate_of: 0001/);

  write(root, '0002-engine-copy.md', post({ title: 'One engine', extra: 'not_duplicate_of: 0001\n', body: 'Why I built one marketing engine for all my apps.' }));
  assert.equal(cli(root, 'check').code, 0);
});

test('check reports broken files', () => {
  const root = tempRoot();
  write(root, '0001-a.md', post({ title: 'A', body: 'First idea about gardens.' }));
  write(root, '0001-b.md', post({ title: 'B', body: 'Second idea about boats.' }));
  write(root, 'notes.md', post({ title: 'C', body: 'Third idea about mountains.' }));
  write(root, '0003-d.md', post({ title: 'D', status: 'someday', body: 'Fourth idea about rivers.' }));
  write(root, '0004-e.md', '---\nstatus: idea\nchannels: tiktok\n---\n\n');
  write(root, '0005-f.md', 'no header at all');
  const r = cli(root, 'check');
  assert.equal(r.code, 1);
  for (const want of [
    /number 0001 is also used by/,
    /notes\.md: the name must look like/,
    /status must be one of/,
    /unknown channel "tiktok"/,
    /0004-e\.md: the header needs a title/,
    /0004-e\.md: write the idea/,
    /0005-f\.md: the file must start with a --- line/,
  ]) assert.match(r.text, want);
});

test('versions for two channels of one idea are fine, the same text in two files is not', () => {
  const root = tempRoot();
  const linkedin = 'I spent a year building alone. Here is the one rule that kept me sane: ship something every Friday.';
  write(root, '0001-rule.md', post({ title: 'One rule', body: `Ship something every Friday.\n\n## LinkedIn\n\n${linkedin}\n\n## X\n\n${linkedin}` }));
  assert.equal(cli(root, 'check').code, 0);
  write(root, '0002-other.md', post({ title: 'Other', body: `Gardens and boats.\n\n## LinkedIn\n\n${linkedin}` }));
  const r = cli(root, 'check');
  assert.equal(r.code, 1);
  assert.match(r.text, /the same post text twice/);

  rmSync(join(root, 'posts', '0002-other.md'));
  const pasted = cli(root, 'add', '--title', 'A year alone', '--text', linkedin);
  assert.equal(pasted.code, 1);
  assert.match(pasted.text, /Already in the repo: 0001/);
});

test('posted records each channel once, --repost on purpose', () => {
  const root = tempRoot();
  cli(root, 'add', '--title', 'One engine', '--text', 'Why I run one marketing engine for all my apps.');
  let r = cli(root, 'posted', '1', '--channel', 'linkedin', '--url', 'https://www.linkedin.com/posts/one', '--date', '2026-11-21');
  assert.equal(r.code, 0, r.text);
  const name = files(root)[0];
  assert.match(read(root, name), /\nstatus: posted\n/);
  assert.match(read(root, name), /\nposted:\n {2}- linkedin 2026-11-21 https:\/\/www\.linkedin\.com\/posts\/one\n---\n/);

  r = cli(root, 'posted', '0001', '--channel', 'linkedin', '--date', '2026-11-22');
  assert.equal(r.code, 1);
  assert.match(r.text, /already on linkedin \(2026-11-21/);

  assert.equal(cli(root, 'posted', '1', '--channel', 'twitter', '--date', '2026-11-22').code, 0);
  assert.equal(cli(root, 'posted', '1', '--channel', 'linkedin', '--date', '2026-12-30', '--repost').code, 0);
  assert.match(read(root, name), /posted:\n {2}- linkedin 2026-11-21 \S+\n {2}- x 2026-11-22\n {2}- linkedin 2026-12-30\n---/);
  assert.equal(cli(root, 'check').code, 0);

  const list = cli(root, 'list');
  assert.match(list.text, /0001 {2}posted .*One engine {2}\[posted: linkedin 2026-11-21, x 2026-11-22, linkedin 2026-12-30\]/);
  assert.match(list.text, /1 idea: 0 idea, 0 draft, 0 approved, 1 posted/);
  assert.match(cli(root, 'list', '--status', 'idea').text, /^0 ideas$/);
});

test('schedule notes and moves a slot, posted clears it, a past date is a reminder', () => {
  const root = tempRoot();
  cli(root, 'add', '--title', 'Ship weekly', '--text', 'Why I release every week.');
  const name = () => files(root)[0];
  let r = cli(root, 'schedule', '1', '--channel', 'x', '--date', '2999-11-24', '--time', '16:00');
  assert.equal(r.code, 0, r.text);
  assert.match(read(root, name()), /\nstatus: approved\n/);
  r = cli(root, 'schedule', '1', '--channel', 'x', '--date', '2999-11-30', '--time', '16:00');
  assert.match(r.text, /moved from 2999-11-24 16:00/);
  assert.equal(cli(root, 'schedule', '1', '--channel', 'linkedin', '--date', '2999-12-01').code, 0);
  assert.match(read(root, name()), /\nscheduled:\n {2}- x 2999-11-30 16:00\n {2}- linkedin 2999-12-01\n---/);
  assert.match(cli(root, 'list').text, /\[scheduled: x 2999-11-30, linkedin 2999-12-01\]/);
  assert.equal(cli(root, 'check').text, '1 ideas checked, no duplicates.');

  r = cli(root, 'posted', '1', '--channel', 'x', '--url', 'https://x.com/example/status/1', '--date', '2999-11-30');
  assert.match(r.text, /was scheduled x 2999-11-30 16:00/);
  assert.match(read(root, name()), /\nstatus: posted\n/);
  assert.match(read(root, name()), /\nscheduled:\n {2}- linkedin 2999-12-01\nposted:\n {2}- x 2999-11-30 \S+\n---/);
  assert.equal(cli(root, 'schedule', '1', '--channel', 'x', '--date', '2999-12-30').code, 1);

  cli(root, 'posted', '1', '--channel', 'linkedin', '--date', '2999-12-01');
  assert.doesNotMatch(read(root, name()), /scheduled/);

  write(root, '0002-late.md', post({ title: 'Late', extra: 'scheduled:\n  - linkedin 2020-01-01 09:00\n', body: 'Gardens and boats.' }));
  r = cli(root, 'check');
  assert.equal(r.code, 0);
  assert.match(r.text, /was scheduled on linkedin for 2020-01-01\. Once it is live, record it: node tools\/posts\.mjs posted 0002/);
  write(root, '0002-late.md', post({ title: 'Late', extra: 'scheduled:\n  - tiktok soon\n', body: 'Gardens and boats.' }));
  assert.match(cli(root, 'check').text, /cannot read the scheduled line "tiktok soon"/);
  assert.equal(cli(root, 'schedule', '1', '--channel', 'x').code, 2);
});

test('version saves and replaces a channel text, unschedule takes a channel off', () => {
  const root = tempRoot();
  const r0 = cli(root, 'add', '--title', 'Emails', '--text', 'I stopped writing long emails.', '--channels', 'linkedin', '--source', 'drafts.md 12-emails', '--note', 'My own idea.');
  assert.equal(r0.code, 0, r0.text);
  const name = () => files(root)[0];
  assert.match(read(root, name()), /\nsource: "drafts\.md 12-emails"\nnote: "My own idea\."\n---/);

  const li = 'I stopped writing long emails.\n\nThree lines say enough.\n\n#Work #Writing #Email';
  let r = cli(root, 'version', '1', '--channel', 'linkedin', '--text', li);
  assert.equal(r.code, 0, r.text);
  assert.match(read(root, name()), /\nstatus: draft\n/);
  assert.match(read(root, name()), /\n## LinkedIn\n\nI stopped writing long emails\.\n\nThree lines say enough\.\n\n#Work #Writing #Email\n$/);

  r = cli(root, 'version', '1', '--channel', 'x', '--text', 'Short emails win.\n\nThree lines are enough.');
  assert.equal(r.code, 0, r.text);
  assert.match(read(root, name()), /\nchannels: linkedin, x\n/);
  r = cli(root, 'version', '1', '--channel', 'linkedin', '--text', 'v2: I stopped writing long emails.');
  assert.equal(r.code, 0);
  const text = read(root, name());
  assert.match(text, /\n## LinkedIn\n\nv2: I stopped writing long emails\.\n\n## X\n\nShort emails win\.\n\nThree lines are enough\.\n$/);
  assert.doesNotMatch(text, /Three lines say enough/);
  assert.equal(cli(root, 'check').code, 0);

  cli(root, 'add', '--title', 'Gardens', '--text', 'What gardening taught me about shipping apps.');
  r = cli(root, 'version', '2', '--channel', 'x', '--text', 'Short emails win. Three lines are enough!');
  assert.equal(r.code, 1);
  assert.match(r.text, /same post text is already in 0001/);
  assert.equal(cli(root, 'version', '2', '--channel', 'x', '--text', '## LinkedIn\nsneaky').code, 2);

  cli(root, 'schedule', '1', '--channel', 'linkedin', '--date', '2999-12-08', '--time', '09:00');
  r = cli(root, 'unschedule', '1', '--channel', 'linkedin', '--drop', '--note', 'Removed from LinkedIn (2999-11-20).');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /removed the linkedin slot \(2999-12-08 09:00\), linkedin taken out of channels/);
  const after = read(root, name());
  assert.doesNotMatch(after, /scheduled/);
  assert.match(after, /\nchannels: x\n/);
  assert.match(after, /\nnote: "My own idea\. Removed from LinkedIn \(2999-11-20\)\."\n/);
  assert.equal(cli(root, 'unschedule', '1', '--channel', 'x').code, 1);
  assert.equal(cli(root, 'check').code, 0);
});

test('posts.config.json picks the channels, with their own headings', () => {
  const root = tempRoot();
  writeFileSync(join(root, 'posts.config.json'), JSON.stringify({ channels: ['Threads', 'Bluesky', 'LinkedIn'] }));
  let r = cli(root, 'add', '--title', 'Small teams', '--text', 'Why small teams ship faster than big ones.');
  assert.equal(r.code, 0, r.text);
  const name = files(root)[0];
  assert.match(read(root, name), /\nchannels: threads, bluesky, linkedin\n/);
  assert.match(read(root, name), /\n## Threads\n\n## Bluesky\n\n## LinkedIn\n$/);
  r = cli(root, 'version', '1', '--channel', 'Bluesky', '--text', 'Small teams ship faster.');
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /Saved the Bluesky version of 0001/);
  assert.match(read(root, name), /\n## Bluesky\n\nSmall teams ship faster\.\n\n## LinkedIn\n$/);
  assert.match(cli(root, 'schedule', '1', '--channel', 'x', '--date', '2999-01-01').text, /channel must be one of threads, bluesky, linkedin/);
  assert.equal(cli(root, 'check').code, 0);

  writeFileSync(join(root, 'posts.config.json'), '{ "channels": [] }');
  r = cli(root, 'check');
  assert.equal(r.code, 2);
  assert.match(r.text, /"channels" must be a list of different names/);
  writeFileSync(join(root, 'posts.config.json'), '{ nope');
  assert.match(cli(root, 'check').text, /posts\.config\.json is not valid JSON/);
  rmSync(join(root, 'posts.config.json'));
  assert.match(cli(root, 'add', '--text', 'Defaults again.', '--dry-run').text, /Would write/);
});

test('Persian ideas are compared too', () => {
  const root = tempRoot();
  assert.equal(cli(root, 'add', '--text', 'چرا یک موتور بازاریابی برای هشت اپ ساختم').code, 0);
  assert.equal(cli(root, 'add', '--text', 'چرا یک موتور بازاریابی برای هشت اپ ساختم!').code, 1);
  assert.equal(cli(root, 'add', '--text', 'سال اول زندگی در سوئد به عنوان برنامه نویس').code, 0);
  assert.match(files(root)[0], /^0001-idea\.md$/);
});

test('find puts the idea with the words first', () => {
  const root = tempRoot();
  cli(root, 'add', '--text', 'How I use Claude agents as a marketing team for my apps.');
  cli(root, 'add', '--text', 'Moving to a new country as a software engineer: the first year.');
  const r = cli(root, 'find', 'country', 'engineer');
  assert.match(r.text.split('\n')[0], /^1\.00 {2}0002/);
  assert.doesNotMatch(r.text, /0001/);
  assert.match(cli(root, 'find', 'pizza').text, /Nothing mentions "pizza"/);
});

test('scores keep real duplicates above ALIKE and different ideas below it', () => {
  const score = (a, b) => similarity(fingerprint(a), fingerprint(b));
  const same = [
    ['Why I run one marketing engine for all my apps instead of a team per app.', 'Why I built one marketing engine for all my apps instead of a team per app.'],
    ['Shipping a side project alone: what I learned about saying no to features.', 'What shipping a side project alone taught me about saying no to features.'],
    ['Lessons from getting rejected by App Store review three times in one week.',
      'Story: I got rejected by App Store review three times in one week. The lessons: read the guidelines line by line, keep a demo account ready, and answer the reviewer within an hour.'],
  ];
  const different = [
    ['Our family app: why we keep stories private and never train on them.', 'Our family app growth: what 1000 downloads taught me about onboarding.'],
    ['How I use Claude agents as a marketing team for my apps.', 'How I use Claude to review my pull requests before I merge them.'],
    ['Gift ideas are hard: why our gift app asks three questions first.', 'Moving to a new country as a software engineer: the first year.'],
  ];
  for (const [a, b] of same) assert.ok(score(a, b) >= ALIKE, `${score(a, b)} for ${a}`);
  for (const [a, b] of different) assert.ok(score(a, b) < ALIKE, `${score(a, b)} for ${a}`);
});

test('wrong commands exit 2 and write nothing', () => {
  const root = tempRoot();
  for (const argv of [['nope'], ['add'], ['add', '--text', '  '], ['add', '--text', 'x', '--keep-both', '7'], ['posted', 'abc'], ['posted', '1', '--channel', 'tiktok'], ['list', '--status', 'later'], ['find'], ['check', '--bogus']]) {
    assert.equal(cli(root, ...argv).code, 2, argv.join(' '));
  }
  assert.deepEqual(files(root), []);
});

// Runs the real script from a temp copy (macOS temp is a symlinked path), reads the idea
// from stdin, and proves the commit hook stops a duplicate commit in a real git repo.
test('the script, stdin and the commit hook work in a real clone', () => {
  const root = tempRoot();
  for (const p of ['tools', '.githooks', 'package.json']) cpSync(join(REPO, p), join(root, p), { recursive: true });
  chmodSync(join(root, '.githooks', 'pre-commit'), 0o755);
  const sh = (cmd, args, input) => spawnSync(cmd, args, { cwd: root, input, encoding: 'utf8', timeout: 20000 });
  const git = (...args) => sh('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args]);

  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('config', 'core.hooksPath', '.githooks').status, 0);

  const add = sh(process.execPath, [join(root, 'tools', 'posts.mjs'), 'add', '--title', "Sam's rule"], "Small releases, and why they're hard.\n");
  assert.equal(add.status, 0, add.stderr);
  assert.match(add.stdout, /Added posts\/0001-sam-s-rule\.md/);
  assert.match(read(root, '0001-sam-s-rule.md'), /title: "Sam's rule"/);
  assert.equal(git('add', '-A').status, 0);
  const ok = git('commit', '-q', '-m', 'first idea');
  assert.equal(ok.status, 0, ok.stderr + ok.stdout);

  write(root, '0002-copy.md', read(root, '0001-sam-s-rule.md'));
  assert.equal(git('add', '-A').status, 0);
  const blocked = git('commit', '-q', '-m', 'duplicate');
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /the same idea twice/);

  // add with no --text and an empty stdin is a clear usage error, not a crash or a hang.
  const empty = sh(process.execPath, [join(root, 'tools', 'posts.mjs'), 'add'], '');
  assert.equal(empty.status, 2, empty.stderr);
  assert.match(empty.stderr, /give the idea with --text|the idea text is empty/);
});
