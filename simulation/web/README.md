# Web 3D viewer assets

`scene.glb` is the exact Blender village (your buildings + Ambassadors), exported without the old `PH_*` placeholder cubes.

```powershell
& ".\tools\blender-4.2.9-windows-x64\blender.exe" --background ".\output\kids_daily_routine_updated.blend" --python ".\scripts\export_web_scene_baked.py"
```

Schedule: `schedule.json` (from `data/daily_schedule.json`).
