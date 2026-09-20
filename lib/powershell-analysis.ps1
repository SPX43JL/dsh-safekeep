$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput([string]$request.command, [ref]$tokens, [ref]$parseErrors)
function Describe-Expression($expression) {
    if ($null -eq $expression) { return $null }
    if ($expression -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
        return @{ text=$expression.Extent.Text; value=$expression.Value; kind='literal' }
    }
    if ($expression -is [System.Management.Automation.Language.ExpandableStringExpressionAst] -and $expression.NestedExpressions.Count -eq 0) {
        return @{ text=$expression.Extent.Text; value=$expression.Value; kind='literal' }
    }
    if ($expression -is [System.Management.Automation.Language.VariableExpressionAst]) {
        return @{ text=$expression.Extent.Text; variable=$expression.VariablePath.UserPath; kind='variable' }
    }
    if ($expression -is [System.Management.Automation.Language.ArrayLiteralAst]) {
        return @{ text=$expression.Extent.Text; items=@($expression.Elements | ForEach-Object { Describe-Expression $_ }); kind='array' }
    }
    return @{ text=$expression.Extent.Text; kind='dynamic' }
}
function Is-TopLevel($node) {
    $cursor = $node.Parent
    while ($null -ne $cursor -and $cursor -ne $ast) {
        if ($cursor -isnot [System.Management.Automation.Language.PipelineAst] -and $cursor -isnot [System.Management.Automation.Language.NamedBlockAst]) { return $false }
        $cursor = $cursor.Parent
    }
    return $cursor -eq $ast
}
$commands = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
    $node = $_
    @{ name=$node.GetCommandName(); text=$node.Extent.Text; start=$node.Extent.StartOffset; end=$node.Extent.EndOffset; top=(Is-TopLevel $node); elements=@($node.CommandElements | ForEach-Object {
        if ($_ -is [System.Management.Automation.Language.CommandParameterAst]) {
            @{ kind='parameter'; name=$_.ParameterName; argument=(Describe-Expression $_.Argument); text=$_.Extent.Text }
        } else { Describe-Expression $_ }
    }) }
})
$assignments = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $true) | ForEach-Object {
    $node = $_
    $expression = $node.Right
    if ($expression -is [System.Management.Automation.Language.StatementBlockAst] -and $expression.Statements.Count -eq 1) { $expression = $expression.Statements[0] }
    if ($expression -is [System.Management.Automation.Language.PipelineAst] -and $expression.PipelineElements.Count -eq 1) { $expression = $expression.PipelineElements[0] }
    if ($expression -is [System.Management.Automation.Language.CommandExpressionAst]) { $expression = $expression.Expression }
    @{ name=$node.Left.Extent.Text.TrimStart('$'); operator=[string]$node.Operator; value=(Describe-Expression $expression); start=$node.Extent.StartOffset; end=$node.Extent.EndOffset; top=(Is-TopLevel $node) }
})
$redirects = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FileRedirectionAst] }, $true) | ForEach-Object {
    @{ path=(Describe-Expression $_.Location); start=$_.Extent.StartOffset; top=(Is-TopLevel $_.Parent); append=$_.Append }
})
$memberCalls = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.InvokeMemberExpressionAst] }, $true) | ForEach-Object { $_.Extent.Text })
@{ commands=$commands; assignments=$assignments; redirects=$redirects; memberCalls=$memberCalls; errors=@($parseErrors | ForEach-Object { $_.Message }) } | ConvertTo-Json -Depth 12 -Compress
