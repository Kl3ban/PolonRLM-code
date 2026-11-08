param([switch]$SkipTests)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location -LiteralPath $projectRoot
try {
    $version = node -p "Number(process.versions.node.split('.')[0])"
    if ($LASTEXITCODE -ne 0 -or [int]$version -lt 24) { throw 'Install Node.js 24 or newer.' }
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    if (-not $SkipTests) {
        npm test
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    }
    npm link
    if ($LASTEXITCODE -ne 0) { throw 'Could not register the PolonRLM command.' }
    $npmPrefix = (npm prefix -g).Trim()
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $pathParts = @($userPath -split ';' | Where-Object { $_ })
    if ($pathParts -notcontains $npmPrefix) {
        [Environment]::SetEnvironmentVariable('Path', (($pathParts + $npmPrefix) -join ';'), 'User')
    }
    if (($env:Path -split ';') -notcontains $npmPrefix) { $env:Path = "$env:Path;$npmPrefix" }
    Write-Host 'PolonRLM is installed. Run: PolonRLM setup'
    Write-Host 'You may need to restart other open terminals.'
} finally { Pop-Location }
