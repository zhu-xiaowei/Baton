# Bedrock regions in the model picker

When Codex is configured with the `amazon-bedrock` provider, `/model` includes
region entries for `us-west-2` and `us-east-1`. Other providers keep their existing
model picker. The Bridge uses its existing AWS role or SSO temporary credentials;
no credentials are requested from or returned to the phone.

1. Select a region in `/model`, or send `/model region us-east-1`.
2. The reply lists test commands for models and reasoning efforts supported by
   both that region and Codex. Send the command for the desired selection.
   Each test sends one short, billable prompt; conversation text is not sent.
3. A successful test returns `/model apply-region <receipt>`. Send it to save
   the selection for the current session's next turn, or append `default` to
   also use it for newly created sessions. Receipts expire after five minutes
   and are scoped to the session, working directory and tested selection.

The current turn and any active Goal must be stopped/paused before saving.
Saving does not resume the thread, take over another writer or alter Codex's
configuration file. The next turn uses a separate app-server process configured
for the selected region. Normal `/model <model> <effort>` changes also update the
session preference.

`/model region clear-default` resets new-session defaults to the backend
configuration; existing session preferences remain. Preferences are saved
atomically in `~/.baton-bridge/bedrock-model-config.json` with owner-only file
permissions on POSIX. This file contains selections, not AWS credentials.

This initial implementation requires Codex app-server support for `config/read`,
`model/list`, `thread/goal/get`, and configuration overrides on `thread/resume`.
Region switching is unavailable if these checks fail. Catalog and connection
test requests use signed HTTPS, bounded timeouts and no redirects.
