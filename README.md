# posts-as-code

Your social posts in a git repo. One Markdown file per idea, with the exact text for each channel, when it is scheduled and where it went live. A duplicate check makes sure the same idea never gets in twice, so nothing goes out twice by accident.

Made for founders and developers who post on LinkedIn and X (or any channel) and draft with an AI agent such as Claude Code. No dependencies: Node 20 or newer.

## Why

- Ideas live in notes apps, drafts and DMs, and the same idea gets written again three months later.
- A post goes out on LinkedIn, then on X a week later with a few words changed, then again next month.
- An agent that drafts posts for you needs one place to check what already exists.

Here everything is a plain file: you can diff it, review it in a pull request and read it on your phone in GitHub.

## Start

1. Click **Use this template** on GitHub and keep the new repo **private** (your unposted ideas are yours).
2. Clone it and run `npm run setup`. This turns on the commit hook that runs the duplicate check.
3. Add your first idea:

```bash
node tools/posts.mjs add --title "Ship small, ship often" --text "Why I release something every Friday, even when it is tiny."
```

It writes `posts/0001-ship-small-ship-often.md`. If the same idea, or one that looks alike, is already there, nothing is written and the match is printed.

## One file per idea

```markdown
---
title: "Ship small, ship often"
status: approved
created: 2026-11-20
channels: linkedin, x
scheduled:
  - linkedin 2026-11-24 09:00
posted:
  - x 2026-11-22 https://x.com/you/status/123
---

Why I release something every Friday, even when it is tiny.

## LinkedIn

Every Friday I ship something. Sometimes it is one button...

## X

Ship small, ship often...
```

- **status**: `idea`, `draft` (channel texts written), `approved` (ready or scheduled), `posted`.
- **channels**: where it is meant to go.
- **scheduled** and **posted**: written by the commands below, one line per channel.
- **not_duplicate_of: 0003**: you looked, and these two ideas are different after all.
- **source** and **note**: free text, for where it came from and anything to remember.

The LinkedIn and X texts of one idea never count as duplicates of each other. The same text in two different ideas does.

## Commands

```bash
node tools/posts.mjs add --title "..." --text "..."           # new idea (text can also come on stdin)
node tools/posts.mjs version 1 --channel linkedin < post.txt  # save or replace a channel's text
node tools/posts.mjs schedule 1 --channel x --date 2026-11-24 --time 16:00
node tools/posts.mjs unschedule 1 --channel linkedin --drop --note "Not for LinkedIn"
node tools/posts.mjs posted 1 --channel x --url https://x.com/you/status/123
node tools/posts.mjs list --status approved                   # what is ready to go
node tools/posts.mjs find ship friday                         # ideas that mention these words
node tools/posts.mjs check                                    # every file valid, no duplicates
```

`posted` refuses a second post of the same idea on the same channel unless you add `--repost`. `check` reminds you when a scheduled date has passed and the post was never marked as live.

## Channels

LinkedIn and X by default. To use others, edit `posts.config.json`:

```json
{ "channels": ["LinkedIn", "X", "Threads", "Bluesky"] }
```

Each name becomes a `## Name` section in the idea files and a `--channel name` value in the commands.

## How the duplicate check works

Two ideas are the same when their words match after dropping case, punctuation, links and accents. That works in any language and script. They look alike when they share most of their words, are a reworded copy, or one short idea sits inside a longer one (score 0.5 or more, see `ALIKE` in `tools/lib.mjs`). Both block `add` and the commit hook. To keep two alike ideas, add `not_duplicate_of` to one of them.

A word check cannot see the same idea in completely different words. `find` ranks such an idea first, which is why the agent instructions say to run `find` and read the closest ideas before filing a new one.

## Working with an AI agent

`CLAUDE.md` tells Claude Code (or any agent that reads it) how to use this repo: check for the same idea before drafting, then record every step with the commands above. Say `post idea: ...` and the agent files it, or tells you it is already idea 12.

## Tests

```bash
npm test
```

Edits made on github.com skip the commit hook; run `node tools/posts.mjs check` after pulling them.

## License

MIT. Made by [Aidin Bazarchi](https://aidinbazarchi.com) ([@AidinBazarchi](https://x.com/AidinBazarchi)). I use it for my own LinkedIn and X posts.
