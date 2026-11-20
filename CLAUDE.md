# Agent instructions

This repo holds the owner's social posts: one file per idea in `posts/`, with each channel's text, schedule and live links. Read `README.md` for the file format. The tool is `node tools/posts.mjs` (run `help`).

## Before drafting any new post

1. `git pull --rebase`: the next idea number comes from the files you have.
2. `node tools/posts.mjs find <3 to 5 key words>` and read the top files. The word check misses the same idea in other words; if one of them is that idea, tell the owner its number and status before writing anything.
3. `node tools/posts.mjs add --dry-run --title "..." --text "..."`. If it is refused, show the owner the match and ask: merge into that file, drop it, or keep both (`--keep-both <ids>`, only on their answer).

## Recording each step

| What happened | Command |
| --- | --- |
| New idea, or "post idea: ..." | `add --title "Short title"` with the idea on stdin, in the owner's own words |
| A channel's text written or changed | `version <n> --channel <name>` with the exact final text on stdin |
| Scheduled, or moved | `schedule <n> --channel <name> --date YYYY-MM-DD --time HH:MM` |
| Taken off a channel | `unschedule <n> --channel <name> [--drop] --note "why"` |
| Live | `posted <n> --channel <name> --url <link>` |

Pass text on stdin with a quoted heredoc so quotes and apostrophes survive:

```bash
node tools/posts.mjs add --title "Short title" <<'EOF'
The idea in the owner's words.
EOF
```

Then `node tools/posts.mjs check`, commit only the files you changed, and push.

## Rules

- Keep unposted ideas private: never copy them into a public repo, a website, a ticket or another service.
- This repo posts nothing. Posting and scheduling on the channels themselves need the owner's OK on the exact text. Recording here only writes down what already happened.
- Run `npm test` before pushing a change to `tools/`.
