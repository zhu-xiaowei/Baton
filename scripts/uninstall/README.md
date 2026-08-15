# Uninstall Baton

Order: uninstall every Bridge, then delete the CloudFormation stack. Cloud
data is permanently deleted.

## 1. Uninstall Bridge

Bridge removal does not delete `~/.claude`, `~/.codex`, or project files.

macOS/Linux:

```bash
./scripts/uninstall/uninstall-bridge.sh --dry-run
./scripts/uninstall/uninstall-bridge.sh
```

Windows PowerShell (Administrator):

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
