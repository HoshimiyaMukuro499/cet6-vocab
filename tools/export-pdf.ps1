# 把 public\单词本.docx 导出为 public\单词本.pdf，用本机 Word 完成。
# 由「推送更新.bat」调用，也可以单独运行。
#
# 本文件必须以「UTF-8 带 BOM」保存：中文 Windows 的 PowerShell 5.1
# 默认按 GBK 读取 .ps1，无 BOM 会导致中文解析错误。

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$docx = Join-Path $root 'public\单词本.docx'
$pdf  = Join-Path $root 'public\单词本.pdf'

if (-not (Test-Path -LiteralPath $docx)) {
    Write-Host "找不到文档：$docx"
    exit 1
}

# ── 区分「你自己的 Word」和「本脚本新建的 Word」 ────────────────────────
# 这是本脚本最容易出事的地方。若 Word 已经开着（常见：你编辑完直接双击推送），
# 就直接复用那个实例，此时：
#   · 绝不能设 Visible = $false —— 那会把你的 Word 窗口整个隐藏掉
#   · 绝不能 Quit() —— 那会连你打开的其它文档一起关掉，未保存内容全丢
# 只有当我们确实新建了实例时，才由我们负责收拾干净。
$word = $null
$weOwnWord = $false
$prevAlerts = $null

if (Get-Process -Name WINWORD -ErrorAction SilentlyContinue) {
    try {
        # 附着到已注册到 ROT 的实例；不会新建进程
        $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    }
    catch {
        # 有 WINWORD 进程却取不到活动对象：多半是上次异常退出留下的僵尸进程，
        # 它没有窗口也不响应自动化。此时新建一个自己的实例更可靠。
        $word = $null
    }
}

if (-not $word) {
    # Word 的关闭是异步的：调用 Quit() 之后进程还要十几秒才真正退出，
    # 这期间新建 COM 实例会失败并报 CO_E_SERVER_EXEC_FAILURE。
    # 连点两次「推送更新」就会撞上，所以这里重试几次而不是直接放弃。
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $word = New-Object -ComObject Word.Application
            $word.Visible = $false
            $weOwnWord = $true
            break
        }
        catch {
            if ($attempt -eq 5) {
                Write-Host "无法启动 Word（已重试 5 次）：$($_.Exception.Message)"
                exit 1
            }
            Start-Sleep -Seconds 3
        }
    }
}

$doc = $null
$code = 0

try {
    $prevAlerts = $word.DisplayAlerts
    $word.DisplayAlerts = 0        # 不弹任何对话框，否则会挂死在无人点击的提示框上

    $doc = $word.Documents.Open([string]$docx, $false, $false)   # ConfirmConversions=false, ReadOnly=false

    # 你可能在 Word 里有未保存的改动：先落盘，
    # 保证推上去的 docx 和导出的 PDF 内容一致
    if (-not $doc.Saved) { $doc.Save() }

    $doc.ExportAsFixedFormat([string]$pdf, 17)   # 17 = wdExportFormatPDF
    Write-Host "PDF 已更新"
}
catch {
    Write-Host "PDF 导出失败：$($_.Exception.Message)"
    $code = 1
}
finally {
    if ($doc) {
        if ($weOwnWord) { try { $doc.Close(0) } catch { } }   # 0 = wdDoNotSaveChanges（上面已保存过）
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($doc) } catch { }
        $doc = $null
    }
    if ($word) {
        if ($null -ne $prevAlerts) { try { $word.DisplayAlerts = $prevAlerts } catch { } }
        if ($weOwnWord) { try { $word.Quit() } catch { } }
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch { }
        $word = $null
    }
    # 必须两次 Collect：第一次回收托管包装器，等待终结器后再回收一次，
    # 否则 ReleaseComObject 之后仍可能残留 WINWORD.EXE 进程
    [GC]::Collect()
    [GC]::WaitForPendingFinalizers()
    [GC]::Collect()
}

exit $code
