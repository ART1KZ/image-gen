import { execFileSync } from 'node:child_process';
const script='$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $acl=[System.IO.File]::GetAccessControl($env:IMAGE_GEN_ACL_TARGET); $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); foreach($rule in $rules) { if($rule.IdentityReference.Value -ne $sid -and $rule.AccessControlType -eq "Allow") { exit 1 } }; Write-Output "private"';
const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,env:{...process.env,IMAGE_GEN_ACL_TARGET:process.argv[2]}});
process.stdout.write(output);
