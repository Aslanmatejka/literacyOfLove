# Web 3D viewer assets

`scene.glb` is the exact Blender village (your buildings + Ambassadors), exported without the old `PH_*` placeholder cubes.

```powershell
& ".\tools\blender-4.2.9-windows-x64\blender.exe" --background ".\output\kids_daily_routine_updated.blend" --python ".\scripts\export_web_scene_baked.py"
```

After every export, shrink the embedded textures (kid maps 2048 → 512 px, PNG → JPEG; ~24 MB → ~8 MB). Geometry and animation are untouched, and it is safe to re-run:

```powershell
node simulation/web/optimize-scene.mjs
```

It also writes `scene.glb.gz` (~2 MB). The viewer downloads that compressed copy and unpacks it in the browser, falling back to `scene.glb` on older browsers, so **always commit both files together** — re-running the script keeps them in step.

Schedule: `schedule.json` (from `data/daily_schedule.json`).
