# claude-mod

A Claude Code marketplace for the mods of ukchucktown. The marketplace has one plugin, `cua-integration`.

## cua-integration

`cua-integration` lets Claude Code operate native macOS apps. The plugin is a wrapper of the Computer Use runtime that the ChatGPT app installs, which is the runtime that Codex uses. The plugin puts a Claude Code approval dialog and a guard between Claude and that runtime. Claude observes an app through its accessibility tree and screenshots, and it acts on an element by its index in that tree. Each app operation asks for your approval in a Claude Code dialog, unless the Codex app already permits the app.

The plugin needs the ChatGPT app on the Mac, and it needs no ChatGPT or Codex subscription. It uses no OpenAI model, and it reads no OpenAI login. A check with Computer Use service 26.1116.1001980 ran on a Mac with no Codex login, and an observation and a click of an app passed. The check did not include an account on a free plan. It also did not show whether the ChatGPT app installs its Computer Use plugin before you sign in. The Computer Use service is software of OpenAI, and it makes network requests that the plugin does not control.

This release supports one host profile on a local Mac: the interactive terminal Claude Code CLI, with no remote client attached.

The plugin also runs in Claude Code Desktop, with no other client attached, but this release makes no support claim for Desktop. The release acceptance did not run in Desktop after the plugin changed how it starts the Computer Use runtime. A later release restores the claim after a Desktop check.

In the CLI and in Desktop, a person must answer each approval dialog. The plugin refuses each call in a headless run, in an Agent SDK host, in the VS Code extension panel, in a cloud session, and while a remote client, such as Remote Control, is attached. The [host support page](docs/host-support.md) lists each surface and the versions that the release was tested with.

## Capabilities

By element index, Claude can do these operations in an app:

- Click an element, or run a secondary action that the element advertises, such as `Scroll Up`.
- Set the value of a text field, type text, paste text, and select text.
- Press a key or a key chord.
- Scroll.

For this plugin, a browser is a native app: Claude operates it through the accessibility tree and the screenshots of its window, as it operates each other app. In a browser, Claude can also load a URL through the address bar, select an option of a `select` element, select a tab, and close a tab. The release was tested with Google Chrome only. An approval of a browser lets Claude read the title of each tab of the observed window.

These capabilities work, but the release has little evidence for them and makes no support claim:

- Coordinate input and drag. Claude can click, scroll, and drag at a point of a screenshot. The checks of this input used one app, on displays with 2 pixels for each point. The plugin refuses this input unless each display of the Mac has 2 pixels for each point.
- A window with no accessibility content, such as the window of a remote desktop client. Claude sees such a window only in its screenshot, so it needs coordinate input and keys there. The plugin tells Claude the rules for such a window, and it waits a settle time after each input before the next observation. The check used one remote desktop window.
- More than one caller at the same time, such as a main session and a subagent. Each caller gets its own runtime, and only one caller at a time acts on an app. No check with two Claude Code callers ran.

This capability is not available:

- Control of a browser through the Chrome extension of the ChatGPT app.

## Requirements

- A Mac with the ChatGPT app and its Computer Use plugin. The ChatGPT app asks for the macOS permissions of its Computer Use service. The plugin does not ask for them or change them.
- Node 24, 25, or 26 as `node` on the `PATH` of Claude Code. For Claude Code Desktop, your login shell profile must put that Node on the `PATH`, because Desktop builds the `PATH` of each session from it.
- The Claude Code CLI, or the Claude desktop app.

An update of the ChatGPT app can change the runtime. The plugin starts a new runtime version when the version passes the contract checks of the plugin, and `/cua status` then reports the version as compatible and unreviewed. When a check fails, the plugin refuses to start, and its message names the contract that changed. A new release of the plugin then follows the new runtime. With `CUA_RUNTIME_PINS=strict` in the environment of Claude Code, the plugin starts only the runtime versions that its release reviewed.

The plugin does not contain the OpenAI runtime. It uses the runtime that the ChatGPT app installs.

## Install

In the Claude Code CLI:

```text
/plugin marketplace add ukchucktown/claude-mod
/plugin install cua-integration@claude-mod
```

In a terminal, these commands do the same:

```sh
claude plugin marketplace add ukchucktown/claude-mod
claude plugin install cua-integration@claude-mod
```

In Claude Code Desktop:

1. Start a Code session.
2. Run `/plugin`. Desktop opens a dialog.
3. In the dialog, add the marketplace `ukchucktown/claude-mod`.
4. In the dialog, install `cua-integration` from the marketplace `claude-mod`.
5. Start a new Code session.

## Use

The plugin starts disabled in each session.

1. Run `/cua status`. The status shows the launcher and the runtime.
2. Run `/cua on` when you want to permit computer-use calls.
3. Ask Claude to do a task in a native app. Answer each approval dialog.
4. Run `/cua off` when you want to refuse new calls. The command also stops the Computer Use service, which removes its agent pointer from the screen. When a call still uses the computer, the service stays, and the output says so.
5. Run `/cua allow-all` when you want no approval dialog for the rest of the session. Read the caution below first.
6. Run `/cua stop-service` when the agent pointer of the Computer Use service stays on the screen after a task and you want to keep CUA on.

Each dialog offers three choices:

- "Allow" answers this request only.
- "Allow for this session" answers later requests for the same app until the launcher stops.
- "Deny" refuses the request, and the dependent action does not run.

Caution: `/cua allow-all` approves each app in advance. While the mode is on, Claude can look at and operate each app on your Mac that the Codex app does not refuse, and no dialog asks you first. You do not see the name of an app before Claude uses it. A web page or a message that Claude reads can thus lead Claude to another app, such as your mail or your password manager. Use the mode only for a task whose apps you trust. `/cua allow-all off` or `/cua off` ends the mode, and it also ends when the launcher stops. `/cua status` shows whether the mode is on.

The plugin keeps no permission after the launcher stops. To use an app without a dialog, add the app to the Computer Use always-allow list in the Codex app. `/cua grants` lists the session grants.

After `/clear` in Claude Code Desktop, run `/cua on` again, because Desktop starts a new launcher. In the CLI, `/mcp reconnect plugin:cua-integration:cua` starts a launcher that stopped.

Caution: An approved action changes the app. A closed connection or `/cua off` does not undo a change.

## Check the prerequisites

The installed plugin has a prerequisite check. It reads files, runs `claude --version`, and changes nothing:

```sh
node ~/.claude/plugins/cache/claude-mod/cua-integration/VERSION/connection/diagnostics.ts
```

Replace `VERSION` with the installed version. The report gives the outcome `ready`, `missing-configuration`, or `unsupported-version`. A `ready` outcome shows only that the runtime is available. It does not show that an app operation works.

## Update

```sh
claude plugin marketplace update claude-mod
claude plugin update cua-integration@claude-mod
```

Run both commands: the first one updates only the list of the marketplace. Then start a new Claude Code session. For Claude Code Desktop, quit the desktop app completely and start it again, because a running session keeps the old version. `/cua status` shows the plugin version, and it tells you when a session runs parts of two versions.

## Uninstall

```sh
claude plugin uninstall cua-integration@claude-mod
claude plugin marketplace remove claude-mod
```

## Settings

Each setting is a variable in the environment of Claude Code.

- `CUA_SETTLE_MS` gives the settle time after an input to a window with no accessibility content, as a whole number of milliseconds from 0 to 10000. The default is 1000. A larger value helps when a remote desktop shows the result of an input late.
- `CUA_CAPTURE_SCALE=0` disables the step that makes the screenshot of a large window smaller before Claude receives it. Use the value only when the screenshots of large windows fail after an update of the ChatGPT app. With the value, a call with more than one screenshot of a large window can fail after 120 seconds.

## Known limitations

- A turn end reports cleanup success as unverified, because the runtime suppresses the failures of its own handlers.
- The native service of the ChatGPT app can keep an app grant after the launcher stops. The plugin does not revoke it.
- The agent pointer of the Computer Use service can stay on the screen after a turn. Run `/cua stop-service` or `/cua off` to stop the service and remove the pointer. The plugin also stops the service when a session that used computer use ends. A Computer Use task of the Codex app that runs at that time loses its service, so do not use computer use in the Codex app and in Claude Code at the same time.
- In Claude Code Desktop, Esc on an approval dialog ends the turn. The dialog approves nothing.
- A call whose result is too large does not return. It ends after 120 seconds, and the plugin starts the runtime again, so Claude binds each app again. A result has this size with about 16 megabytes of text and images together. The message of the failure names this cause.
- For a window on a Space that no display shows, a click at a point, a drag, and a scroll fail. A click by element index and keys still reach such a window.

## Source

A private development repository builds each release. Each release commit in this repository names the commit of the development repository that it copies.

## License

[MIT](LICENSE)
