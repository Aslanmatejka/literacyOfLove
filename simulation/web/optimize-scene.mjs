#!/usr/bin/env node
/**
 * Shrinks the textures embedded in the web scene (scene.glb).
 *
 * The Blender quality pass bakes 2048x2048 PNG maps for each kid. On screen a
 * kid is only ~150 px tall, so those maps cost ~17 MB of download and ~400 MB
 * of GPU memory for no visible gain. This script:
 *   - downsizes kid maps (images named "HQ_*") to 512 px, others to max 1024 px
 *   - re-encodes opaque PNGs as JPEG (quality 90) when that is smaller
 * Geometry, animation, materials and node names are left untouched.
 * It also writes scene.glb.gz (~2 MB instead of ~8 MB), which the viewer
 * downloads and unpacks in the browser.
 * Safe to re-run: images that are already small JPEGs are skipped.
 *
 * Windows only (uses the built-in System.Drawing via PowerShell; no npm deps).
 *
 *   node simulation/web/optimize-scene.mjs [input.glb] [output.glb]
 *
 * Defaults to optimizing simulation/web/assets/scene.glb in place.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_GLB = path.join(HERE, 'assets', 'scene.glb');
const KID_MAX = 512;      // kid albedo maps ("HQ_*")
const OTHER_MAX = 1024;   // ground / wall tiles
const JPEG_QUALITY = 90;

const input = path.resolve(process.argv[2] || DEFAULT_GLB);
const output = path.resolve(process.argv[3] || input);

/** Gzipped copy next to the scene; always refreshed so it never goes stale. */
function writeGzip(file) {
  const gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 });
  fs.writeFileSync(`${file}.gz`, gz);
  console.log(`${path.basename(file)}.gz: ${(gz.length / 1e6).toFixed(1)} MB (served compressed, unpacked in the browser)`);
}

/* ---------- GLB read ---------- */
const glb = fs.readFileSync(input);
if (glb.toString('latin1', 0, 4) !== 'glTF') throw new Error(`${input} is not a GLB file`);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
const binHeader = 20 + jsonLen;
if (glb.toString('latin1', binHeader + 4, binHeader + 8) !== 'BIN\0') throw new Error('GLB has no BIN chunk');
const bin = glb.subarray(binHeader + 8, binHeader + 8 + glb.readUInt32LE(binHeader));
if ((json.buffers || []).length !== 1) throw new Error('Expected exactly one buffer');

const viewData = json.bufferViews.map((bv) => {
  const start = bv.byteOffset || 0;
  return bin.subarray(start, start + bv.byteLength);
});

/* ---------- image inspection ---------- */
function imageInfo(buf) {
  if (buf.readUInt32BE(0) === 0x89504e47) {
    const colorType = buf[25];
    const hasTrns = buf.includes(Buffer.from('tRNS', 'latin1'));
    const alpha = colorType === 4 || colorType === 6 || (colorType === 3 && hasTrns);
    return { type: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), alpha };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let o = 2;
    while (o < buf.length) {
      const marker = buf[o + 1];
      const len = buf.readUInt16BE(o + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: 'jpeg', height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7), alpha: false };
      }
      o += 2 + len;
    }
  }
  return null;
}

/* ---------- plan jobs ---------- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lol-glb-'));
const jobs = [];
json.images.forEach((img, i) => {
  if (img.bufferView === undefined) return;
  const data = viewData[img.bufferView];
  const info = imageInfo(data);
  if (!info) return;
  const maxSize = /^HQ_/i.test(img.name || '') ? KID_MAX : OTHER_MAX;
  const needsResize = Math.max(info.width, info.height) > maxSize;
  const wantJpeg = !info.alpha;
  if (!needsResize && (info.type === 'jpeg' || !wantJpeg)) return; // already optimal
  const ext = info.type === 'png' ? 'png' : 'jpg';
  const inFile = path.join(tmp, `in_${i}.${ext}`);
  const outFile = path.join(tmp, `out_${i}.${wantJpeg ? 'jpg' : 'png'}`);
  fs.writeFileSync(inFile, data);
  jobs.push({ index: i, name: img.name, info, needsResize, input: inFile, output: outFile, maxSize, jpeg: wantJpeg, quality: JPEG_QUALITY });
});

if (!jobs.length) {
  console.log('Nothing to optimize — textures are already small.');
  if (output !== input) fs.copyFileSync(input, output);
  writeGzip(output);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

/* ---------- resize / encode with System.Drawing ---------- */
const ps = String.raw`
param([string]$JobsPath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$jpegCodec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
foreach ($job in (Get-Content -Raw -Path $JobsPath | ConvertFrom-Json)) {
  $src = [System.Drawing.Image]::FromFile($job.input)
  try {
    $scale = [Math]::Min(1.0, $job.maxSize / [Math]::Max($src.Width, $src.Height))
    $w = [Math]::Max(1, [int][Math]::Round($src.Width * $scale))
    $h = [Math]::Max(1, [int][Math]::Round($src.Height * $scale))
    $fmt = if ($job.jpeg) { [System.Drawing.Imaging.PixelFormat]::Format24bppRgb } else { [System.Drawing.Imaging.PixelFormat]::Format32bppArgb }
    $dst = New-Object System.Drawing.Bitmap -ArgumentList $w, $h, $fmt
    $g = [System.Drawing.Graphics]::FromImage($dst)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $attrs = New-Object System.Drawing.Imaging.ImageAttributes
    $attrs.SetWrapMode([System.Drawing.Drawing2D.WrapMode]::TileFlipXY)
    $rect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $w, $h
    $g.DrawImage($src, $rect, 0, 0, $src.Width, $src.Height, [System.Drawing.GraphicsUnit]::Pixel, $attrs)
    $g.Dispose()
    if ($job.jpeg) {
      $params = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
      $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$job.quality)
      $dst.Save($job.output, $jpegCodec, $params)
    } else {
      $dst.Save($job.output, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $dst.Dispose()
  } finally {
    $src.Dispose()
  }
}
`;
const psFile = path.join(tmp, 'resize.ps1');
const jobsFile = path.join(tmp, 'jobs.json');
fs.writeFileSync(psFile, ps);
fs.writeFileSync(jobsFile, JSON.stringify(jobs));
execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, jobsFile], { stdio: 'inherit' });

/* ---------- swap image data ---------- */
let saved = 0;
for (const job of jobs) {
  const img = json.images[job.index];
  const before = viewData[img.bufferView];
  const after = fs.readFileSync(job.output);
  // Without a resize, only keep the re-encode if it actually saves bytes.
  if (!job.needsResize && after.length >= before.length) continue;
  const outInfo = imageInfo(after);
  viewData[img.bufferView] = after;
  img.mimeType = job.jpeg ? 'image/jpeg' : 'image/png';
  saved += before.length - after.length;
  console.log(`${(img.name || `image ${job.index}`).padEnd(32)} ${job.info.width}x${job.info.height} ${job.info.type} ${(before.length / 1e6).toFixed(2)} MB -> ${outInfo.width}x${outInfo.height} ${outInfo.type} ${(after.length / 1e6).toFixed(2)} MB`);
}
fs.rmSync(tmp, { recursive: true, force: true });
if (saved === 0 && !jobs.some((job) => job.needsResize)) {
  console.log('Nothing to optimize — textures are already small.');
  if (output !== input) fs.copyFileSync(input, output);
  writeGzip(output);
  process.exit(0);
}

/* ---------- GLB write (bufferViews repacked in original order, 4-byte aligned) ---------- */
const order = json.bufferViews.map((bv, i) => i).sort((a, b) => (json.bufferViews[a].byteOffset || 0) - (json.bufferViews[b].byteOffset || 0));
const parts = [];
let offset = 0;
for (const i of order) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) { parts.push(Buffer.alloc(pad)); offset += pad; }
  json.bufferViews[i].byteOffset = offset;
  json.bufferViews[i].byteLength = viewData[i].length;
  parts.push(viewData[i]);
  offset += viewData[i].length;
}
json.buffers[0].byteLength = offset;
const binOut = Buffer.concat([...parts, Buffer.alloc((4 - (offset % 4)) % 4)]);
let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20)]);

const header = Buffer.alloc(12);
header.write('glTF', 0, 'latin1');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBuf.length + 8 + binOut.length, 8);
const chunk = (buf, type) => {
  const h = Buffer.alloc(8);
  h.writeUInt32LE(buf.length, 0);
  h.write(type, 4, 'latin1');
  return [h, buf];
};
const result = Buffer.concat([header, ...chunk(jsonBuf, 'JSON'), ...chunk(binOut, 'BIN\0')]);
const tmpOut = `${output}.tmp`;
fs.writeFileSync(tmpOut, result);
fs.renameSync(tmpOut, output);
writeGzip(output);
console.log(`\n${path.basename(input)}: ${(glb.length / 1e6).toFixed(1)} MB -> ${(result.length / 1e6).toFixed(1)} MB (textures saved ${(saved / 1e6).toFixed(1)} MB)`);
