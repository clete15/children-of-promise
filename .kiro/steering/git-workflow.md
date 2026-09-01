# Git Workflow (IMPORTANT)

## `git` is NOT on the system PATH

On this machine, running plain `git` fails. Windows can't find `git.exe`, so it
pops up a "Select an app to open 'git'" dialog (the flashing app-picker icon) and
the command returns exit code -1 with no output. This is NOT a shell bug — it means
git was invoked by the bare name `git`.

**Always call git by its full path:**

```
& "C:\Program Files\Git\cmd\git.exe" <args>
```

Never run bare `git ...` in a terminal command on this machine.

## Standard push sequence

Repo root: `c:\Users\child\source\repos\Children Of Promise`
Branch: `master` · Remote: `origin` (https://github.com/clete15/children-of-promise.git)

```powershell
& "C:\Program Files\Git\cmd\git.exe" add "<path/to/file>"
& "C:\Program Files\Git\cmd\git.exe" commit -m "<message>"
& "C:\Program Files\Git\cmd\git.exe" push
```

## Reading git output reliably

This terminal garbles inline output (it echoes the command characters). The real
output appears AFTER the `powershell.exe` marker lines, and can get truncated. When
output matters (push result, status, log), redirect to a temp file and read it:

```powershell
& "C:\Program Files\Git\cmd\git.exe" push > _push.txt 2>&1
& "C:\Program Files\Git\cmd\git.exe" status -sb >> _push.txt 2>&1
& "C:\Program Files\Git\cmd\git.exe" log --oneline -3 >> _push.txt 2>&1
```

Then read `_push.txt` (note: it may be UTF-16 with spaced-out characters, still
readable) and delete it afterward.

## Confirming a push succeeded

- `push` output shows `To github.com...` (new commits) or `Everything up-to-date`.
- `status -sb` shows `## master...origin/master` with NO `[ahead N]` marker.
- `log --oneline` shows the new commit at the top.

## Deploy

After a successful push, deploy via the portal Deploy button
(https://childrenofpromisedaycare.com/staff) or `git pull` + `.\startup.bat` on the server.
