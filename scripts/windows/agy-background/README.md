# AGY from a Windows background Host

An optional launcher for a Remote Host running as a Windows scheduled task with
S4U logon. Such a task can run the CLI but may not have a credential-bearing logon
session for AGY's existing Windows Credential Manager login.

The launcher selects an Explorer token belonging to **the same Windows SID**,
starts AGY with `CreateProcessWithTokenW` in the calling service session, and
forwards the existing stdin/stdout/stderr handles. Both the launcher (GUI
subsystem) and AGY (`CREATE_NO_WINDOW`) remain windowless. A kill-on-close Job
Object ties AGY and its children to the launcher, including timeout and
cancellation. Executable arguments are quoted individually; no command shell is
involved. Credentials are neither exported nor logged.

This is an explicit operator-installed launcher, not automatic token discovery
inside the plugin. The Host needs permission to duplicate that user's token and
`SeImpersonatePrivilege`; the child remains the logged-in user, not LocalSystem.
The AGY path is a locally controlled absolute path in `agy-path.txt` next to the
launcher. Protect this directory to the same standard as the Host executable.

## Install

On the source Windows machine, using .NET 8 or newer:

```powershell
$ErrorActionPreference = 'Stop'
$destination = 'D:\Remote\tools\agy-background'
dotnet build .\scripts\windows\agy-background\Launcher.csproj -c Release -o $destination
if ($LASTEXITCODE -ne 0) { throw 'Launcher build failed' }
Set-Content -LiteralPath (Join-Path $destination 'agy-path.txt') -Encoding utf8NoBOM -Value 'C:\absolute\path\to\agy.exe'
```

Set the Antigravity backend command to the installed `agy-background.exe`, keeping
its normal `--input-format stream-json --output-format stream-json` arguments.
Model discovery passes `models` through the same launcher. Do not change the
Codex Host task to interactive logon.

A .NET 8 Windows runtime is required for this framework-dependent build. Check the
installed runtime before changing the backend command. This launcher currently
requires an existing same-user interactive login to obtain its token. It does not
establish a new credential-bearing login after a cold boot before login; in that
case it returns `AGY_AUTH_CONTEXT_UNAVAILABLE` instead of launching OAuth or a
console window. A password-backed scheduled task under the native user is another
Windows-supported deployment option when unattended startup is required; its
credentials must be configured locally with Windows, never in Remote settings.

## Verify

```powershell
node .\scripts\windows\agy-background\verify.mjs $destination 'D:\Remote\private-tests'
if ($LASTEXITCODE -ne 0) { throw 'Launcher verification failed' }
```

The Windows-only check uses a synthetic Node child to exercise Unicode/empty/quoted
arguments, cwd, piped input/output, exit codes, and cancellation of descendants.
Also verify AGY's real model catalog, a synthetic prompt through encrypted Remote,
and history recovery after reconnect. Do not substitute this process check for
actual subscription or UI acceptance.
