<#
  Makes photos web-ready, in place (Windows; uses the built-in System.Drawing):
    - turns phone photos upright (applies the camera's rotation tag)
    - removes all metadata, including the GPS location of where a photo was taken
    - scales the long edge down to 1920 px and saves as JPEG quality 82
    - with -Thumbs, also writes an 800 px copy to images/thumbs/ (used by the gallery grid)

  Run it after adding new photos:
    powershell -ExecutionPolicy Bypass -File tools/optimize-photos.ps1 images/new-photo.jpg
  With no file names it processes every JPEG the pages use, and makes thumbnails
  for the gallery photos.
#>
[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$Paths,
    [int]$MaxEdge = 1920,
    [int]$Quality = 82,
    [switch]$Thumbs,
    [int]$ThumbEdge = 800,
    [int]$ThumbQuality = 78
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }

function Get-UsedPhotos {
    $pages = Get-ChildItem -Path *.html, styles.css
    git ls-files | Where-Object { $_ -match '\.(jpe?g)$' -and $_ -notmatch '^images/thumbs/' } | Where-Object {
        Select-String -Path $pages -SimpleMatch -Pattern (Split-Path $_ -Leaf) -Quiet
    }
}

function Get-GalleryPhotos {
    [regex]::Matches((Get-Content -Raw gallery.html), 'class="gallery-item[^"]*"[^>]*>\s*<img src="([^"]+)"') | ForEach-Object { $_.Groups[1].Value }
}

function Save-Jpeg($image, $edge, $quality, $outPath) {
    $scale = [Math]::Min(1.0, $edge / [Math]::Max($image.Width, $image.Height))
    $w = [Math]::Max(1, [int][Math]::Round($image.Width * $scale))
    $h = [Math]::Max(1, [int][Math]::Round($image.Height * $scale))
    $bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $g.DrawImage($image, (New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h), 0, 0, $image.Width, $image.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $g.Dispose()
    $params = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$quality)
    $bmp.Save($outPath, $jpegCodec, $params) # a fresh bitmap: no metadata is carried over
    $bmp.Dispose()
    return "${w}x${h}"
}

$rotations = @{ 2 = 'RotateNoneFlipX'; 3 = 'Rotate180FlipNone'; 4 = 'Rotate180FlipX'; 5 = 'Rotate90FlipX'; 6 = 'Rotate90FlipNone'; 7 = 'Rotate270FlipX'; 8 = 'Rotate270FlipNone' }
$explicit = [bool]$Paths
if (-not $Paths) { $Paths = Get-UsedPhotos; $Thumbs = $true }
$gallery = if ($Thumbs) { if ($explicit) { $Paths } else { Get-GalleryPhotos } } else { @() }
$before = 0; $after = 0

foreach ($path in $Paths) {
    $full = (Resolve-Path $path).Path
    $bytes = [System.IO.File]::ReadAllBytes($full)
    $stream = New-Object System.IO.MemoryStream -ArgumentList (, $bytes)
    $img = [System.Drawing.Image]::FromStream($stream)
    try {
        $ids = $img.PropertyIdList
        $orient = if ($ids -contains 0x0112) { [BitConverter]::ToUInt16($img.GetPropertyItem(0x0112).Value, 0) } else { 1 }
        $hasGps = $ids -contains 0x0002 -or $ids -contains 0x0001
        $rotated = $rotations.ContainsKey([int]$orient)
        if ($rotated) { $img.RotateFlip([System.Drawing.RotateFlipType]::($rotations[[int]$orient])) }
        $tooBig = [Math]::Max($img.Width, $img.Height) -gt $MaxEdge -or $bytes.Length -gt 400KB
        if ($tooBig -or $hasGps -or $rotated) {
            $tmp = "$full.tmp.jpg"
            $size = Save-Jpeg $img $MaxEdge $Quality $tmp
            $newLen = (Get-Item $tmp).Length
            # Keep the new file if it is smaller, or if it removes a location / rotation tag
            if ($newLen -lt $bytes.Length -or $hasGps -or $rotated) {
                Move-Item -Force $tmp $full
                $note = @(); if ($hasGps) { $note += 'GPS removed' } else { $note += 'metadata removed' }; if ($rotated) { $note += 'turned upright' }
                '{0,-42} {1,6} KB -> {2,5} KB  {3} {4}' -f $path, [int]($bytes.Length / 1KB), [int]($newLen / 1KB), $size, ($note -join ', ')
                $before += $bytes.Length; $after += $newLen
            } else {
                Remove-Item $tmp
            }
        }
        if ($gallery -contains $path) {
            $thumbDir = Join-Path (Split-Path $full) 'thumbs'
            New-Item -ItemType Directory -Force $thumbDir | Out-Null
            $thumb = Join-Path $thumbDir (Split-Path $full -Leaf)
            Save-Jpeg $img $ThumbEdge $ThumbQuality $thumb | Out-Null
        }
    } finally {
        $img.Dispose(); $stream.Dispose()
    }
}
if ($before) { 'Total: {0:N1} MB -> {1:N1} MB' -f ($before / 1MB), ($after / 1MB) }
