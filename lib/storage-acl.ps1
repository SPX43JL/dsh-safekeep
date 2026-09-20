param([Parameter(Mandatory)][string]$LiteralPath)
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = Get-Acl -LiteralPath $LiteralPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
$trusted = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($identity in $trusted) {
    $principal = [System.Security.Principal.SecurityIdentifier]::new($identity)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($principal, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
[System.IO.FileSystemAclExtensions]::SetAccessControl([System.IO.DirectoryInfo]::new($LiteralPath), $acl)
$actual = Get-Acl -LiteralPath $LiteralPath
if (!$actual.AreAccessRulesProtected) { throw 'Private storage ACL is not protected' }
$rules = $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $trusted) { throw 'Unexpected storage ACL principal' }
}
@{ private=$true; sid=$sid.Value; pwsh=$PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Compress
