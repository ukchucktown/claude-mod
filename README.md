# claude-mod

A Claude Code marketplace for the mods of ukchucktown. The marketplace has one plugin, `cua-integration`.

## cua-integration

`cua-integration` lets Claude Code operate native macOS apps through the Computer Use runtime of the ChatGPT app. Claude observes an app through its accessibility tree and screenshots, and it acts on an element by its index in that tree. Each app operation asks for your approval in a Claude Code dialog, unless the Codex app already permits the app.

The plugin supports two host profiles on a local Mac:

- The interactive terminal Claude Code CLI, with no remote client attached
- Claude Code Desktop, with no other client attached

In both profiles, a person must answer each approval dialog. The plugin refuses each call in a headless run, in an Agent SDK host, in the VS Code extension panel, in a cloud session, and while a remote client, such as Remote Control, is attached. The [host support page](docs/host-support.md) lists each surface and the versions that the release was tested with.

The plugin does not support these capabilities:

- Coordinate input and drag. Claude can operate only the elements that an app exposes in its accessibility tree.
- The browser surface of the ChatGPT app. The plugin includes it, off by default, and it has no live acceptance in Claude Code.
- More than one caller that controls apps at the same time.

## Requirements

- A Mac with the ChatGPT app and its Computer Use plugin. The ChatGPT app asks for the macOS permissions of its Computer Use service. The plugin does not ask for them or change them.
- Node 24, 25, or 26 as `node` on the `PATH` of Claude Code. For Claude Code Desktop, your login shell profile must put that Node on the `PATH`, because Desktop builds the `PATH` of each session from it.
- The Claude Code CLI, or the Claude desktop app.

The plugin starts only the runtime versions that its release reviewed. After an update of the ChatGPT app changes the runtime, the plugin refuses to start, and its message names the changed package. A new release of the plugin then reviews the new runtime.

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
4. Run `/cua off` when you want to refuse new calls.

Each dialog offers three choices:

- "Allow" answers this request only.
- "Allow for this session" answers later requests for the same app until the launcher stops.
- "Deny" refuses the request, and the dependent action does not run.

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

Start a new Claude Code session after the update.

## Uninstall

```sh
claude plugin uninstall cua-integration@claude-mod
claude plugin marketplace remove claude-mod
```

## Known limitations

- A turn end reports cleanup success as unverified, because the runtime suppresses the failures of its own handlers.
- The native service of the ChatGPT app can keep an app grant after the launcher stops. The plugin does not revoke it.
- In Claude Code Desktop, Esc on an approval dialog ends the turn. The dialog approves nothing.

## Source

A private development repository builds each release. Each release commit in this repository names the commit of the development repository that it copies.

## License

[MIT](LICENSE)
