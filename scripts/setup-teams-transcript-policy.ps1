# TDOT — Teams application access policy for meeting transcripts + recordings.
#
# Grants the automation's Azure app permission to read a specific organizer
# mailbox's Teams online-meeting artifacts (transcripts). Run this ONCE, as a
# Microsoft Teams administrator, on any machine with PowerShell.
#
#   ./setup-teams-transcript-policy.ps1
#     (it prompts for the two values), or pass them:
#   ./setup-teams-transcript-policy.ps1 -AppId "<MS_CLIENT_ID>" -Organizer "<MEETING_ORGANIZER_EMAIL>"
#
# Where to get the values:
#   AppId     = Azure Portal -> App registrations -> "TDOT Automations" -> Overview
#               -> "Application (client) ID"   (same as the MS_CLIENT_ID Render env var)
#   Organizer = the MEETING_ORGANIZER_EMAIL Render env var (the mailbox that creates the meetings)

param(
  [string]$AppId      = "",
  [string]$Organizer  = "",
  [string]$PolicyName = "TDOT-Transcripts",
  [switch]$Global                      # grant tenant-wide instead of to just the organizer
)

$ErrorActionPreference = "Stop"

if (-not $AppId)     { $AppId     = Read-Host "Application (client) ID  (MS_CLIENT_ID)" }
if (-not $Organizer -and -not $Global) { $Organizer = Read-Host "Organizer mailbox  (MEETING_ORGANIZER_EMAIL)" }

Write-Host "`n== Connecting to Microsoft Teams (sign in as a Teams admin) ==" -ForegroundColor Cyan
if (-not (Get-Module -ListAvailable -Name MicrosoftTeams)) {
  Write-Host "Installing the MicrosoftTeams module..." -ForegroundColor Yellow
  Install-Module MicrosoftTeams -Scope CurrentUser -Force -AllowClobber
}
Import-Module MicrosoftTeams
Connect-MicrosoftTeams | Out-Null

Write-Host "`n== Creating / updating policy '$PolicyName' for app $AppId ==" -ForegroundColor Cyan
$existing = Get-CsApplicationAccessPolicy -Identity $PolicyName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Policy exists — setting its AppIds." -ForegroundColor Yellow
  Set-CsApplicationAccessPolicy -Identity $PolicyName -AppIds $AppId
} else {
  New-CsApplicationAccessPolicy -Identity $PolicyName -AppIds $AppId `
    -Description "TDOT automation - read consultation transcripts + recordings"
}

if ($Global) {
  Write-Host "`n== Granting '$PolicyName' tenant-wide (all users) ==" -ForegroundColor Cyan
  Grant-CsApplicationAccessPolicy -PolicyName $PolicyName -Global
} else {
  Write-Host "`n== Granting '$PolicyName' to $Organizer ==" -ForegroundColor Cyan
  Grant-CsApplicationAccessPolicy -PolicyName $PolicyName -Identity $Organizer
}

Write-Host "`n== Done. Current policy: ==" -ForegroundColor Green
Get-CsApplicationAccessPolicy -Identity $PolicyName | Format-List Identity, AppIds, Description

Write-Host "Propagation can take up to ~30 minutes." -ForegroundColor Cyan
Write-Host "Then verify with:  POST https://tdot-automations.onrender.com/api/transcript-preflight" -ForegroundColor Cyan
Write-Host "  (header  X-Api-Key: <ADMIN_API_KEY>)" -ForegroundColor Cyan
