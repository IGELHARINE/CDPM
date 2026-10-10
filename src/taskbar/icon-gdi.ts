// Windows: GDI+(System.Drawing)로 아이콘을 그린다. 유리 느낌의 브라우저 창 모양 + 슬롯 번호.
// - 숫자는 PC의 시스템 글꼴(Segoe UI 굵게)로 그린다 (저장소에 글꼴 파일을 넣지 않기 위해). 슬롯마다 한 번 만들어 저장해 두고 재사용.
// - 모든 크기를 실제 픽셀 단위로 직접 계산해 그린다. 작은 크기(48px 이하)는 경계·막대·점·숫자 위치를 정수 픽셀에 맞추고
//   글자 힌팅을 켜서, 작업표시줄(24px 등)에서 경계가 번지거나 지글거리지 않게 한다.
// - 숫자는 가로로는 눈에 보이는 가운데(테두리 상자 중심과 잉크 무게중심의 중간)를, 세로로는 위·아래 빈칸이 같게 창 본문에 놓는다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = String.raw`
param([string]$OutDir, [int]$Slot, [string]$Hex, [string]$Sizes)
# 오류가 나면 바로 멈춰 실패로 알린다 (조용히 넘어가 망가진 아이콘이 저장되지 않게)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$base = [System.Drawing.ColorTranslator]::FromHtml($Hex)
function C([int]$a) { [System.Drawing.Color]::FromArgb($a, $base.R, $base.G, $base.B) }
function W([int]$a) { [System.Drawing.Color]::FromArgb($a, 255, 255, 255) }
# 주의: PowerShell에는 'r' 별칭(Invoke-History)이 있어 함수 이름으로 R을 쓰면 별칭이 먼저 불린다
function SnapPx([double]$v) { [double][Math]::Round($v) }
function RoundRect([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = [single]($r * 2)
  $p.AddArc([single]$x, [single]$y, $d, $d, 180, 90); $p.AddArc([single]($x + $w - 2 * $r), [single]$y, $d, $d, 270, 90)
  $p.AddArc([single]($x + $w - 2 * $r), [single]($y + $h - 2 * $r), $d, $d, 0, 90); $p.AddArc([single]$x, [single]($y + $h - 2 * $r), $d, $d, 90, 90)
  $p.CloseFigure(); return $p
}
# 실제 아이콘(숫자 그리기 직전 상태 $pre)의 복사본에 숫자를 그려, 잉크가 있는 줄(배경보다 50% 이상 밝아진 줄)의 위·아래를 잰다.
# (따로 투명한 판에 그리면 글자 가장자리가 실제와 다르게 나와서, 실제와 똑같이 그려 본다)
function InkRows($pre, [string]$str, [single]$em, [single]$x, [single]$y) {
  $w = $pre.Width; $h = $pre.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $lb = $pre.Clone($rect, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $lg = [System.Drawing.Graphics]::FromImage($lb)
  $lg.SmoothingMode = 'AntiAlias'; $lg.PixelOffsetMode = 'Half'; $lg.CompositingQuality = 'HighQuality'; $lg.TextRenderingHint = 'AntiAliasGridFit'
  $lf = New-Object System.Drawing.Font($family, $em, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
  $lg.DrawString($str, $lf, [System.Drawing.Brushes]::White, (New-Object System.Drawing.PointF($x, $y)), $fmt); $lg.Dispose()
  $fmtA = [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
  $d1 = $pre.LockBits($rect, 'ReadOnly', $fmtA); $d2 = $lb.LockBits($rect, 'ReadOnly', $fmtA)
  $b1 = New-Object byte[] ($d1.Stride * $h); $b2 = New-Object byte[] ($d2.Stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($d1.Scan0, $b1, 0, $b1.Length); [System.Runtime.InteropServices.Marshal]::Copy($d2.Scan0, $b2, 0, $b2.Length)
  $ls = $d1.Stride; $pre.UnlockBits($d1); $lb.UnlockBits($d2); $lb.Dispose()
  $first = -1; $last = -1
  for ($yy = 0; $yy -lt $h; $yy++) {
    for ($xx = 0; $xx -lt $w; $xx++) {
      $o = $yy * $ls + $xx * 4
      $s1 = [int]$b1[$o] + $b1[$o + 1] + $b1[$o + 2]; $s2 = [int]$b2[$o] + $b2[$o + 1] + $b2[$o + 2]
      if ($s1 -lt 765 -and ($s2 - $s1) -ge (765 - $s1) / 2.0) { if ($first -lt 0) { $first = $yy }; $last = $yy; break }
    }
  }
  return @($first, $last)
}
$text = [string]$Slot
$family = $null
foreach ($name in @('Segoe UI Variable Display', 'Segoe UI', 'Arial')) {
  try { $family = New-Object System.Drawing.FontFamily($name); break } catch {}
}
$fmt = [System.Drawing.StringFormat]::GenericTypographic

foreach ($s in ($Sizes -split ',')) {
  $size = [int]$s
  $k = $size / 64.0
  $small = $size -le 48
  $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'Half'; $g.CompositingQuality = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  # 창 모양: 칸을 꽉 채운다. 경계가 정수 픽셀에 오도록 (0,0)~(size,size)
  $radius = [Math]::Max(2.0, (SnapPx (11 * $k)))
  $win = RoundRect 0 0 $size $size $radius
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush((New-Object System.Drawing.PointF(0, -1)), (New-Object System.Drawing.PointF(0, ($size + 1))), (C 255), (C 205))
  $grad.WrapMode = 'TileFlipXY'
  $g.FillPath($grad, $win)

  # 위 막대 (높이 16/64, 정수 픽셀): 몸통보다 진하게 + 아래 경계 1px 밝은 선
  $barH = [Math]::Max(3.0, (SnapPx (16 * $k)))
  $g.SetClip($win)
  $g.SmoothingMode = 'None'
  $g.FillRectangle((New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(85, 0, 0, 0))), [single]0, [single]0, [single]$size, [single]$barH)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush((W 70))), [single]0, [single]$barH, [single]$size, [single]1)

  $g.ResetClip()
  $g.SmoothingMode = 'AntiAlias'

  # 점 3개: 지름·간격·위치를 정수 픽셀로 (작은 크기에서도 또렷하게 떨어져 보이게)
  $dotD = [Math]::Max(2.0, (SnapPx (6.4 * $k)))
  $gap = [Math]::Max(1.0, (SnapPx (2.6 * $k)))
  $dotY = [Math]::Floor(($barH - $dotD) / 2)
  $dotX = [Math]::Max(1.0, (SnapPx (6.5 * $k)))
  $dot = New-Object System.Drawing.SolidBrush((W 245))
  foreach ($i in 0, 1, 2) { $g.FillEllipse($dot, [single]($dotX + $i * ($dotD + $gap)), [single]$dotY, [single]$dotD, [single]$dotD) }

  # 흰 테두리: 작은 크기는 정확히 1px 안쪽 선, 큰 크기는 비례 두께
  $pw = if ($small) { 1.0 } else { [Math]::Max(1.0, $k) }
  $border = RoundRect ($pw / 2) ($pw / 2) ($size - $pw) ($size - $pw) ([Math]::Max(1.0, $radius - $pw / 2))
  $g.DrawPath((New-Object System.Drawing.Pen((W 128), [single]$pw)), $border)

  # 숫자 크기: 한 자리든 두 자리든 같은 크기 (64칸 기준 33, 작업표시줄 크기에서는 조금 키움)
  $emU = 33
  if ($size -le 32) { $emU = $emU * 1.12 }
  $em = [single]($emU * $k)
  # 작은 크기: 숫자 위·아래 빈칸을 정확히 같게 하려면 (본문 높이 - 숫자 높이)가 짝수여야 한다.
  # 숫자 높이가 맞지 않으면 글자 크기를 가장 적게(2% 단위, 최대 ±8%) 바꿔 맞춘다.
  # (둥근 숫자 0·8 등은 평평한 1·4·7보다 1px 더 튀어나와서, 높이는 그 슬롯의 번호로 잰다)
  $spaceTop = $barH + 1; $spaceBottom = $size - 2
  if ($small) {
    $g.Flush()
    $pre = $bmp.Clone((New-Object System.Drawing.Rectangle(0, 0, $size, $size)), ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
    foreach ($d in 0, -0.02, 0.02, -0.04, 0.04, -0.06, 0.06, -0.08, 0.08) {
      $try = [single]($emU * $k * (1 + $d))
      $rows = InkRows $pre $text $try ([single]($size * 0.1)) ([single]($spaceTop))
      if ((($spaceBottom - $spaceTop + 1) - ($rows[1] - $rows[0] + 1)) % 2 -eq 0) { $em = $try; break }
    }
  }
  $tp = New-Object System.Drawing.Drawing2D.GraphicsPath
  $tp.AddString($text, $family, [int][System.Drawing.FontStyle]::Bold, $em, (New-Object System.Drawing.PointF(0, 0)), $fmt)
  $b = $tp.GetBounds()

  # 잉크 무게중심: 숫자를 마스크에 그려 평균 x를 잰다 ("1"처럼 한쪽에 꺾임이 있으면 상자 중심과 다르다)
  $mk = [Math]::Max(1.0, 96.0 / [Math]::Max(1.0, $b.Height))
  $mw = [int][Math]::Ceiling($b.Width * $mk) + 4; $mh = [int][Math]::Ceiling($b.Height * $mk) + 4
  $mask = New-Object System.Drawing.Bitmap $mw, $mh, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $mg = [System.Drawing.Graphics]::FromImage($mask); $mg.SmoothingMode = 'AntiAlias'
  $mg.ScaleTransform([single]$mk, [single]$mk); $mg.TranslateTransform([single](2 / $mk - $b.X), [single](2 / $mk - $b.Y))
  $mg.FillPath([System.Drawing.Brushes]::White, $tp); $mg.Dispose()
  $data = $mask.LockBits((New-Object System.Drawing.Rectangle(0, 0, $mw, $mh)), 'ReadOnly', ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $bytes = New-Object byte[] ($data.Stride * $mh)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
  $stride = $data.Stride; $mask.UnlockBits($data); $mask.Dispose()
  $sum = 0.0; $wsum = 0.0
  for ($yy = 0; $yy -lt $mh; $yy++) { $rowStart = $yy * $stride; for ($xx = 0; $xx -lt $mw; $xx++) { $al = $bytes[$rowStart + $xx * 4 + 3]; if ($al) { $sum += $al * $xx; $wsum += $al } } }
  $centroidX = $b.X + (($sum / [Math]::Max(1.0, $wsum)) + 0.5 - 2) / $mk
  $opticalX = (($b.X + $b.Width / 2) + $centroidX) / 2

  # 창 본문(막대 아래) 정중앙으로. 작은 크기는 정수 픽셀 위치에 놓는다.
  # 본문: 막대 아래 경계선 다음 줄부터 아래 테두리 바로 위까지
  $cx = $size / 2.0; $cy = ($barH + 1 + $size - $pw) / 2.0
  $dx = $cx - $opticalX; $dy = $cy - ($b.Y + $b.Height / 2)
  if ($small) {
    $dx = SnapPx $dx; $dy = SnapPx $dy
    # 실제로 그려지는 잉크를 재서 위·아래 빈칸이 같아지도록 정수 픽셀만큼 옮긴다
    $rows = InkRows $pre $text $em ([single]$dx) ([single]$dy)
    if ($rows[0] -ge 0) { $dy += [Math]::Floor((($spaceBottom - $rows[1]) - ($rows[0] - $spaceTop)) / 2.0) }
  }

  if ($small) {
    # 작은 크기: 힌팅(글자를 픽셀 격자에 맞춤)을 켠 글자 그리기로 줄기를 또렷하게
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $font = New-Object System.Drawing.Font($family, $em, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel))
    $g.DrawString($text, $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.PointF([single]$dx, [single]$dy)), $fmt)
  } else {
    $t = New-Object System.Drawing.Drawing2D.Matrix
    $t.Translate([single]$dx, [single]$dy)
    $tp.Transform($t)
    $g.FillPath([System.Drawing.Brushes]::White, $tp)
  }

  $g.Dispose()
  $bmp.Save((Join-Path $OutDir "$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  # 작은 크기용 BMP(DIB) 항목을 만들 수 있게 픽셀 원본(BGRA, 위에서 아래로)도 저장
  $bd = $bmp.LockBits((New-Object System.Drawing.Rectangle(0, 0, $size, $size)), 'ReadOnly', ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb))
  $raw = New-Object byte[] ($size * $size * 4)
  for ($ry = 0; $ry -lt $size; $ry++) { [System.Runtime.InteropServices.Marshal]::Copy([IntPtr]($bd.Scan0.ToInt64() + $ry * $bd.Stride), $raw, $ry * $size * 4, $size * 4) }
  $bmp.UnlockBits($bd)
  [System.IO.File]::WriteAllBytes((Join-Path $OutDir "$size.raw"), $raw)
  $bmp.Dispose()
}
`;

export interface RenderedIcon {
  png: Buffer;
  /** 픽셀 원본: BGRA, 위에서 아래로, 알파는 곱하지 않은 값 */
  bgra: Buffer;
}

/** 크기별 PNG와 픽셀 원본. 실패하면 undefined (그때는 기본 그리기로 대체). */
export function renderPngsWithGdi(slot: number, color: string, sizes: number[]): Map<number, RenderedIcon> | undefined {
  if (process.platform !== 'win32') return undefined;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdpm-icon-'));
  const script = path.join(dir, 'icon.ps1');
  try {
    fs.writeFileSync(script, '﻿' + SCRIPT, 'utf8');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OutDir', dir, '-Slot', String(slot), '-Hex', color, '-Sizes', sizes.join(',')], {
      windowsHide: true, stdio: 'ignore', timeout: 60_000,
    });
    const out = new Map<number, RenderedIcon>();
    for (const s of sizes) out.set(s, { png: fs.readFileSync(path.join(dir, `${s}.png`)), bgra: fs.readFileSync(path.join(dir, `${s}.raw`)) });
    return out;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
