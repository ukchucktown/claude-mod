# Host support

This page lists the Claude Code host surfaces of `cua-integration`, the managed policies that affect it, and the versions that its release acceptance used.

## Surfaces

On each surface, the plugin controls native macOS apps only. A browser is a native app for this plugin: Claude operates it through the accessibility tree and the screenshots of its window, and the plugin has no connection to a browser extension. The release was tested with Google Chrome only. When you approve a browser, Claude can read the title of each tab of the observed window, the names of the extensions in the toolbar, and the name of the browser profile.

The plugin makes its checks before it starts an approval, so a refused call opens no dialog.

| Surface                                                        | Status                    | Behavior                                                                                                                                                                                   |
| -------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Interactive terminal CLI on a local Mac, with no remote client | Supported                 | The plugin asks for each approval in the Claude Code question dialog.                                                                                                                      |
| Claude Code Desktop on a local Mac, with no other client       | Not claimed, not refused  | The release acceptance of this version did not run in Desktop. The plugin asks for each approval in the Claude Code question dialog. Esc on the dialog ends the turn and approves nothing. |
| Remote Control client, such as the mobile app, attached        | Unsupported, refused      | The plugin refuses each call while the client is attached, and it permits calls again after the client detaches.                                                                           |
| Claude Desktop attached as a remote client to a CLI session    | Unsupported, refused      | The plugin refuses each call while Desktop is attached.                                                                                                                                    |
| Headless `claude -p` run and Agent SDK host                    | Unsupported, refused      | Nobody can answer an approval dialog, so the plugin refuses each call.                                                                                                                     |
| VS Code extension panel                                        | Unsupported, refused      | No live check ran in the panel.                                                                                                                                                            |
| Cloud session                                                  | Unsupported, refused      | The plugin controls apps on the local Mac only.                                                                                                                                            |
| Terminal CLI in the integrated terminal of VS Code             | Unsupported, not detected | No live check ran in this terminal. The session looks like the terminal profile, so the plugin permits the call.                                                                           |
| Terminal CLI on a Mac through SSH                              | Unsupported, not detected | The plugin operates the apps of the remote Mac, and the person at the terminal does not necessarily see them. Use the plugin on the local Mac only.                                        |

## Managed policies

A managed policy has more authority than the plugin:

- When a policy loads only managed hooks, the plugin loads no hooks. The `/cua` command does not exist, and the launcher refuses each call.
- Permission rules, managed hooks, and a tool permission ceiling apply unchanged. The plugin never answers a more permissive verdict.
- An installation of the plugin as a managed plugin is unsupported.

## Tested versions

The release acceptance of version 0.4.0 used these versions:

| Component            | Version                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude Code CLI      | 2.1.330                                                                                                              |
| Google Chrome        | 158.0.8127.37, the only browser of the acceptance                                                                    |
| Claude Desktop       | None. No acceptance ran in Desktop with this start of the runtime                                                    |
| Computer Use runtime | 26.1117.41037, with `@oai/cua-repl` 0.1.6, `@oai/cua` 0.2.8, and `@oai/sky` 0.7.24, under Codex CLI 0.171.0-alpha.13 |
| macOS                | 27.2.1                                                                                                               |
| Node                 | 24.19.0                                                                                                              |

The plugin starts only these runtime package versions. Other Claude Code versions run the plugin, but the release acceptance did not cover them.
