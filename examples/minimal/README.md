# Minimal example

A stdio MCP server with three tools, one per kind of risk:

| Tool           | What it does               | Declared as                    | What happens                     |
| -------------- | -------------------------- | ------------------------------ | -------------------------------- |
| `search_notes` | Searches notes             | `none`, role `reader`          | Runs directly                    |
| `add_note`     | Adds a note                | `low`, reversible, `editor`    | Runs directly                    |
| `send_email`   | Sends an email (simulated) | `high`, irreversible, `editor` | Held back until a human confirms |

Nothing leaves your machine. Notes live in memory, and the "email" is a line written to
stderr. `send_email` goes through `envelope()`, the way an existing integration that
returns `{ success, data, error }` would.

## Run it

From the repository root, after `npm ci`:

```sh
npx tsx examples/minimal/server.ts
```

The server speaks MCP on stdin/stdout, so it waits for a client. To use it from Claude
Code:

```sh
claude mcp add notes-example -- npx tsx "$PWD/examples/minimal/server.ts"
```

Or, in any client that takes a JSON configuration:

```json
{
  "mcpServers": {
    "notes-example": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/mcp-tool-bridge/examples/minimal/server.ts"],
      "env": { "EXAMPLE_PRINCIPAL_ID": "alice", "EXAMPLE_PRINCIPAL_ROLES": "reader,editor" }
    }
  }
}
```

Launch the server directly, not through `npm run`: npm writes its own lines to stdout,
which is the protocol channel.

## Things to try

- Ask for the notes about invoices. `search_notes` runs.
- Ask to add a note. `add_note` runs.
- Ask to email Ada at `ada@example.com`. `send_email` does not run. If your client
  supports elicitation, it asks you to allow the action, and the email is "sent" only
  on a yes. Otherwise the model is told that confirmation is pending. The token is in
  the result's `_meta`, for a host application to redeem.
- Send to `ghost@example.invalid`. Once confirmed, the simulated legacy function fails,
  and the model reads its error message.
- Set `EXAMPLE_PRINCIPAL_ROLES=reader`. Only `search_notes` is listed, and calling the
  others by name gets `Unknown tool`.
- Watch stderr: every call leaves JSON audit events there, with the email body masked.

`test/example.test.ts` runs this server as a child process and checks all of the above
except elicitation, which the protocol tests cover.
