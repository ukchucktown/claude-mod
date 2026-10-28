# Host support

This page lists the Claude Code host surfaces of `cua-integration`, the managed policies that affect it, and the versions that its release acceptance used.

## Surfaces

The plugin makes its checks before it starts an approval, so a refused call opens no dialog.

| Surface                                                        | Status                    | Behavior                                                                                                                                            |
| -------------------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive terminal CLI on a local Mac, with no remote client | Supported                 | The plugin asks for each approval in the Claude Code question dialog.                                                                               |
| Claude Code Desktop on a local Mac, with no other client       | Supported                 | The plugin asks for each approval in the Claude Code question dialog. Esc on the dialog ends the turn and approves nothing.                         |
| Remote Control client, such as the mobile app, attached        | Unsupported, refused      | The plugin refuses each call while the client is attached, and it permits calls again after the client detaches.                                    |
| Claude Desktop attached as a remote client to a CLI session    | Unsupported, refused      | The plugin refuses each call while Desktop is attached.                                                                                             |
| Headless `claude -p` run and Agent SDK host                    | Unsupported, refused      | Nobody can answer an approval dialog, so the plugin refuses each call.                                                                              |
| VS Code extension panel                                        | Unsupported, refused      | No live check ran in the panel.                                                                                                                     |
| Cloud session                                                  | Unsupported, refused      | The plugin controls apps on the local Mac only.                                                                                                     |
| Terminal CLI in the integrated terminal of VS Code             | Unsupported, not detected | No live check ran in this terminal. The session looks like the terminal profile, so the plugin permits the call.                                    |
| Terminal CLI on a Mac through SSH                              | Unsupported, not detected | The plugin operates the apps of the remote Mac, and the person at the terminal does not necessarily see them. Use the plugin on the local Mac only. |

## Managed policies

A managed policy has more authority than the plugin:

- When a policy loads only managed hooks, the plugin loads no hooks. The `/cua` command does not exist, and the launcher refuses each call.
- Permission rules, managed hooks, and a tool permission ceiling apply unchanged. The plugin never answers a more permissive verdict.
- An installation of the plugin as a managed plugin is unsupported.

## Tested versions

The release acceptance of version 0.2.4 used these versions:

| Component            | Version                                                                               |
| -------------------- | ------------------------------------------------------------------------------------- |
| Claude Code CLI      | 2.1.311 for the native workflow, and 2.1.312 for the session grants                   |
| Claude Desktop       | 3.6556.2, with its copy of Claude Code 2.1.308, and 2.1.309 for one repeated scenario |
| Computer Use runtime | 26.1021.31345, with `@oai/cua-repl` 0.1.2, `@oai/cua` 0.2.6, and `@oai/sky` 0.7.13    |
| macOS                | 27.0.1                                                                                |
| Node                 | 24.21.0                                                                               |

The plugin starts only these runtime package versions. Other Claude Code versions run the plugin, but the release acceptance did not cover them.
