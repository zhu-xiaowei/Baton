---
name: release
description: Publish a Baton version as the Latest GitHub Release from main. Use only when the user explicitly runs $release <version> or asks to publish that release; when they only ask about releasing, answer without publishing.
---

# Baton release

Follow `.claude/commands/release.md` with the requested version. Prepare up to a
green PR, then summarize and ask before merging; after confirmation (or at once
with `--auto`) merge, deploy the hosted service, publish the Latest release,
update dl.agentbaton.app and TestFlight without further prompts. Stop on any failure; re-running resumes completed steps.
