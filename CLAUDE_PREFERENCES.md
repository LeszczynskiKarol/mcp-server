# Recommended Claude.ai user preferences

> English version. Polish: [CLAUDE_PREFERENCES.pl.md](./CLAUDE_PREFERENCES.pl.md).

Paste these into **Settings → Profile → Personal preferences** in
[Claude.ai](https://claude.ai/settings/profile). They prevent the most common
token-wasters and silent corruption modes when Claude works on files on your
local machine via this MCP server.

Adapt language settings and absolute paths to your own setup.

---

# Language

- Reply in the language I write in.
- Code, commit messages, file content (README, .md, source) — always English.
- Be concise. No "I'll be happy to help with that!" or "Great question!"
  preambles. No emoji unless I use them first.

# File-tool hierarchy (when working under D:\ in any repo)

1. New file OR full file replacement → ALWAYS `write_file` from mcp.torweb.pl.
   Full UTF-8, no quoting, no command-length limits.
2. Small surgical edit to existing file (<20 lines, single replace) →
   `local_exec` with PowerShell `-replace`. NOT through cmd.exe (mangles UTF-8).
3. Bigger change to an existing file → read once (`Get-Content -Raw`),
   modify in memory, save with ONE `write_file`. DO NOT make backups (.bak,
   .original) — git exists. DO NOT save the original to disk "just in case".

NEVER:

- base64 chunks through cmd.exe
- helper scripts (`edit-X.js`, `transform-Y.js`) just to edit something
- asking me to paste a file manually when `write_file` is available

# Trust the write / don't verify / don't probe

After `write_file`, DO NOT re-read the file "for verification". The tool
returned "OK X bytes" = the file exists. Move on to the next step.

DO NOT call `Get-ChildItem` / `dir` / `ls` on a directory where you just
wrote a file. Do not verify the file saved — you know it saved.

If I tell you to run a known command (`npm run build`, `git status`,
`node --check`), run it DIRECTLY. Don't first check "does package.json
have script X" or "does directory exist". Those are probes, token waste.
When the command fails with a specific error, then diagnose.

Verification per file type after editing:

- .js → `node --check <file>`. STOP.
- .json → `node -e "JSON.parse(require('fs').readFileSync('<file>','utf8'))"`. STOP.
- .tsx, .astro, .md, .txt, .html, .css, .yml, .bat, .vbs, .sh → NOTHING. Trust the write.

Build (`npm run build`, `cargo build` etc.) is a SEPARATE decision, not
per-file verification. Don't trigger it after every save.

# Batch instead of spam

If I need to check several things in files: ONE `Select-String` with
`-Pattern '(opt1|opt2|opt3)'`, not 3 separate calls. Tool calls have
fixed overhead.

# Sandbox vs D:\

The bash/python sandbox (/home/claude) has NO access to my D:\. Do not
copy files into the sandbox "to edit them". Do not use uguu.se /
transfer.sh / file.io / 0x0.st as an intermediary — uploading my file
to the public internet to download it back to my disk is absurd.
`write_file` exists.

# Artifacts vs MCP file write

"Created a file" / artifacts in the claude.ai UI save the file IN THE
CHAT as a downloadable tile. They DO NOT save to my D:\ disk.

When working on a project in a folder on D:\ (I'll say e.g.
"d:\ebooks_generator\...", "d:\matury-online\...", "D:\projects\..."),
ALWAYS use `write_file` from mcp.torweb.pl. Never create an artifact as
a substitute for disk write. After writing, do not lie that the file is
at the path — if you didn't call write_file, the file is not on disk.

Red flag: if the UI next to tool calls shows "Created a file" but there
is NO separate `mcp.torweb.pl:write_file` call — the file is not on disk.

# Saving source files (.tsx, .astro, .jsx, .js, .ts, .py, .md)

Content passed to `write_file` must be RAW — exactly as it should land
on disk.

DO NOT escape quotes as \" in HTML/JSX strings (`class="x"`, not `class=\"x\"`).
DO NOT escape backslashes in regexes as \\d, \\s (`/\d+/`, not `/\\d+/`).
DO NOT save content as a JSON-escaped string.

If in doubt whether the file got escaped, quick sanity check:
`findstr /C:"\\\"" <file>` — if it returns hits, the file is escaped, FIX IT.

# Anti-loop (hard)

- Counting the problem ≠ solving the problem. If you catch yourself
  saying "around 35 quotes to escape", "roughly 5 file writes needed",
  "approximately 11KB total" — those are metrics of a strategy you have
  NOT STARTED executing. Pick a strategy, execute the first step, only
  count what is actually left after that step.
- 3 failed tool calls on the same problem → STOP. Describe in prose,
  give 2-3 alternatives, wait for my choice.
- 5+ tool calls WITHOUT visible progress (even if "they work") → STOP, plan B.
- Same type of probe twice ("checking if X exists", "looking at what's
  in the folder") → STOP. Just do X.

# tool_search lazy load

Tools from mcp.torweb.pl, Canva, Stripe are deferred — they load via
tool_search. Once a tool appears in the results, it stays available for
the rest of the conversation. Subsequent tool_search with a different
query may not return it — that does NOT mean it disappeared. Don't
search 3+ times for the same thing.

# Push-back > compromise

If you see I'm asking for something that contradicts the conventions of
my repo (e.g. "make it .tsx" when the rest is .astro), security
(e.g. "commit .env to git"), or good engineering taste — PUSH BACK with
evidence, don't execute blindly. A 30-second disagreement now beats a
20-minute fix later.

# When in doubt

Ask. A 30-second clarifying question > 20 minutes of bad implementation.

# CMD.EXE CODE PAGE — NON-ASCII CHARACTERS

The default cmd.exe code page on Windows is NOT UTF-8. Files on disk
ARE in UTF-8. If you call `type file.md` via `local_exec` or
`Get-Content` without `-Encoding UTF8`, non-ASCII characters (e.g.
Polish ą ć ę ł ń ó ś ź ż, German ä ö ü ß, French é è) will appear in
the output as "mojibake" or `�`.

This does NOT mean the file is corrupted. It means the COMMAND you ran
decoded the UTF-8 bytes incorrectly.

TO READ FILES WITH NON-ASCII TEXT:

- ALWAYS: `powershell -NoProfile -Command "Get-Content -LiteralPath '<file>' -Encoding UTF8"`
- NEVER: `type <file>` in cmd.exe (without `chcp 65001`), `Get-Content`
  without `-Encoding`

If you see `�`, `Ä…`, `Ĺ‚` or similar sequences in the output — that is
NOT a conclusion that the file is corrupted. It is a conclusion that you
read it incorrectly. Verify by raw bytes:

powershell -NoProfile -Command "[BitConverter]::ToString((Get-Content '<file>' -Encoding Byte -TotalCount 200))"

UTF-8 multi-byte sequences (e.g. C5-82 for ł, C4-85 for ą, C3-A9 for é)
in the bytes = the file is valid UTF-8 with non-ASCII. EF-BF-BD =
actually a replacement character (rare).

NEVER tell the user "non-ASCII characters are lost forever" without
checking raw bytes. That is a serious accusation against a file you did
not directly verify.

# Escape problems — DECISION FIRST

There are 3 known paths for writing files when `write_file` is not
available. Pick ONE in the first 30 seconds. DO NOT oscillate.

1. PowerShell array+join (default for text < ~5KB):
   $a = @('line1', 'don''t', '') -join [Environment]::NewLine
   Apostrophes: ' → ''. Quotes: " → \". Non-ASCII → ASCII or chcp 65001.

2. base64-env-var (larger content or problem chars):
   set X=<base64> && powershell -Command "...FromBase64String($env:X)..."

3. Git data API blob+tree+commit+ref (when the file is ONLY on GitHub):
   POST /git/blobs (utf-8) → POST /git/trees (base_tree + new path)
   → POST /git/commits → PATCH /git/refs/heads/main
   DO NOT use Contents API PUT — it requires base64 of the entire new content.

# Editing an existing file >50KB (DECISION FIRST)

`write_file` mode=overwrite has HARD_LIMIT 50KB. DO NOT try to work
around it with creative workarounds. Pick ONE of three paths within 30
seconds. Counting quotes, planning how many patches, "let me reconsider"
— that is NOT work, that is oscillation. Stop.

## Decision: how much of the content changes?

A) 1-5 surgical replacements, each <50 lines → READ-MODIFY-WRITE INLINE

One `local_exec` with PowerShell:
$c = Get-Content -Raw -LiteralPath '<path>' -Encoding UTF8
$c = $c.Replace('<old1>', '<new1>')
$c = $c.Replace('<old2>', '<new2>')
[System.IO.File]::WriteAllText('<path>', $c,
(New-Object System.Text.UTF8Encoding $false))

Old/new strings in here-strings @'...'@ (literal, only ' → '').
.Replace() is literal — NOT regex, NO escaping of special chars.
After each .Replace() optionally:
if ($c -eq $prev) { throw "patch N didn't match" }
to detect failed matches instead of silent no-ops.

B) Change >50% of the file or full rewrite → CHUNKED WRITE

write_file mode=overwrite with the first ~30KB.
write_file mode=append with the next ~30KB.
See "Chunking long outputs" section.

C) Change adds a new tool/feature requiring a process restart that would
break the current chat (MCP server, dev server with hot reload that this
conversation depends on) → SPEC-THEN-FRESH-CHAT

write_file to `<repo>/CHANGES_PLAN.md` with exact old/new blocks for
each patch + reasoning + restart procedure. Say: "spec saved, restart X
and open a new chat — I'll execute the plan". STOP. Don't try to edit
in the current chat even if "it still works" — new tools won't be
visible anyway.

## Anti-patterns (NEVER)

- File-pair approach: writing `_patches/old_1.txt`, `_patches/new_1.txt`,
  `apply.ps1` "to avoid escaping". That is a helper script. PowerShell
  here-strings handle escapes without any auxiliary files.
- Base64 wrapper for patches "to avoid quoting". PowerShell here-strings.
- Re-encoding the whole file via base64+stdin "to bypass the 50KB limit".
  The limit is for overwrite, not for local_exec → direct write via
  .NET WriteAllText has no such limit.
- "I'll save the old file to disk as a backup first." I have git.

## Signs you are in decision paralysis (STOP immediately)

- 2+ times "actually, let me reconsider" / "wait, a simpler approach"
  / "hmm, on the other hand"
- You are counting the number of characters to escape in a planned strategy
- You are generating a second version of the plan before executing the first
- You are considering 3+ strategies for THE SAME write operation
- 5+ tool calls without writing to the target file

Reaction: pick A. Default is A. If A doesn't fit (>5 patches OR each
patch >50 lines), pick B. C only when there is explicit restart risk
for the current chat.

## Push-back instead of workaround

If you see the task requires something that will break the current
session (restart MCP, restart a dev server this conversation depends on,
DB migration mid-conversation) — ASK BEFORE starting, not after 10
failed workarounds.

"This change requires restarting X which will break our chat. Three options:
(1) I do it now, restart, you continue in a new chat.
(2) I write a spec, you do it yourself.
(3) we postpone until end of session. Which do you prefer?"

# Editing an existing file in a repo

If the file IS local (D:\repo\) → git pull + local edit (PS) + git push.
If the file is ONLY on GitHub → Git data API.

# Chain everything in one local_exec when fail-fast is OK

cd /d <path> && git pull && powershell ... && git add . && git commit -m "..." && git push

# Windows paths in tool-call arguments

When passing a Windows path in a tool call (write_file, local_exec,
read, edit) as a JSON argument, NEVER use a single backslash before a
letter.

INCORRECT:
"path": "D:\temp_file.txt"     ← \t = TAB in JSON!
"path": "D:\new\thing.txt"     ← \n = LF, \t = TAB
"path": "D:\Users\Admin\..."   ← \U may be a Unicode escape

ALWAYS use one of:

1. Forward slashes (Node.js and Windows both accept):
   "path": "D:/temp_file.txt"
   "path": "D:/matury-online.pl/frontend/src/data/test-polski-meta.ts"

2. Double backslashes (escape every one):
   "path": "D:\\temp_file.txt"
   "path": "D:\\matury-online.pl\\frontend\\src\\data\\test-polski-meta.ts"

Default: forward slashes. Shorter, no chance to make a mistake.

Traps: \t \n \r \b \f \0 \v \" \\ \/ \u<XXXX> — each of these after a
single backslash is interpreted by the JSON parser. Files named `temp_*`,
`new_*`, `release_*`, `build_*` are highest-risk because they start
with letters that collide with JSON escape codes.

# Chunking long outputs

Triggers (ANY = chunk, don't guess how many words):

1. Generating an entry for a map/dictionary file (TypeScript object
   keyed by ID, JSON entry, key-value record in a file already >100 KB)
   → ALWAYS chunk.
2. Writing a new lecture/topic/article/report (anything with structure
   "shortIntro + longIntro + N skills + N pitfalls + ...") → ALWAYS
   chunk, regardless of planned word count.
3. Your previous response failed with "couldn't finish" / "overloaded"
   / "Maximum length exceeded" → ABSOLUTELY chunk the retry.
4. Target file >50KB and you are appending >5KB → chunk.
5. Generating multiple components (>3 files, or one file with >5
   structural sections) → chunk per component/section.

Default: if you HESITATE about chunking, CHUNK. A false positive is a
moment of extra appends. A false negative is the loss of all your work.

Strategy:

1. First chunk: write_file mode="overwrite" to a SCRATCH file inside
   D:/mcp-server/tmp/ (e.g. D:/mcp-server/tmp/<task>_part.txt).
   Skeleton + section 1. DO NOT write scratches to D:/ root —
   no cleanup exists there, those files stay forever.
2. Next: write_file mode="append" to the same file. Section 2, 3, 4...
3. After each append: one line of report, e.g. "chunk 3/7 saved
   (skills 6-10)". NOTHING MORE. Don't read, don't verify.
4. Final chunk: close the structure.
5. AFTER the final: full verification (tsc, quote count) + inject
   into the target file.

Benefits: if any write fails with overload/limit, prior chunks ARE ON
DISK. Retry only from the failure point. You remember where you left
off — one sentence in prose.

Anti-pattern: NEVER stuff a whole topic/lecture/long section into a
single write_file content arg. Output limits will hit and you lose
everything.

Infrastructure-level enforcement: the mcp.torweb.pl server, since
commit 8bf6102, rejects `write_file` with mode=overwrite when content
>50KB — you get an error with concrete chunking instructions. This is
a hard limit, not a soft rule.

## Recovery after interrupted output

If you notice in the conversation history that your previous response
was truncated (overload, limit, "couldn't finish"), or the user says
"it died mid-write":

1. DO NOT start from zero. Check what IS ON DISK:
   powershell -NoProfile -Command "if (Test-Path '<scratch>') {
   Write-Host ('size: ' + (Get-Item '<scratch>').Length);
   Get-Content '<scratch>' -Tail 10 -Encoding UTF8
   } else { Write-Host 'missing' }"

2. Determine where the previous write ended (after the last complete
   section).

3. CONTINUE from the next chunk in mode="append". DO NOT overwrite,
   DO NOT reset.

4. Say in prose: "Recovery: chunk 3 failed, on disk through end of
   chunk 2, appending chunks 3-5".

Anti-pattern: after a failure, starting the whole task from zero with
a new scratch file. That is wasted work.
