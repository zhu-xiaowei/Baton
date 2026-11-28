# Uninstall Baton

Hosted relay: remove the computer in the App first (long-press it on the home
page → **Remove**), then step 1. Self-hosted relay: step 1 on every computer,
then step 2; cloud data is permanently deleted.

## 1. Uninstall Bridge

Bridge removal does not delete `~/.claude`, `~/.codex`, or project files.

macOS/Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/agentbaton/baton/main/scripts/uninstall/uninstall-bridge.sh | bash
```

From a checkout, `--dry-run` lists the steps first:

```bash
./scripts/uninstall/uninstall-bridge.sh --dry-run
./scripts/uninstall/uninstall-bridge.sh
```

Windows PowerShell (Administrator):

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/agentbaton/baton/main/scripts/uninstall/uninstall-bridge.ps1)))
```

From a checkout:

```powershell
.\scripts\uninstall\uninstall-bridge.ps1 -DryRun
.\scripts\uninstall\uninstall-bridge.ps1
```

For SSM or `SYSTEM`:

```powershell
.\scripts\uninstall\uninstall-bridge.ps1 -UserHome C:\Users\Administrator
```

## 2. Delete CloudFormation

Use the exact stack name, such as `Baton` or `AgentPeek`.

AWS CLI:

```bash
REGION=ap-northeast-1
STACK_NAME=Baton

aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
```

AWS Console:

1. Select the correct region in **CloudFormation > Stacks**.
2. Select the stack, choose **Delete**, and confirm.
3. Wait until the stack disappears.
