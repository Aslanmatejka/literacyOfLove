# Web simulation assets

- `daily_schedule.json` — schedule + world positions for Three.js
- `faces/` — kid portraits exported from Blender face previews
- `village_overview.glb` — optional (run Blender export script); procedural village used if missing
- `media/{kidId}_{Location}.mp4` — optional close-up clips (e.g. `kid_01_Well.mp4`)

Rebuild from the Blender project:

```powershell
cd simulation
python scripts/07_export_web_assets.py
# optional GLB:
# .\tools\blender-4.2.9-windows-x64\blender.exe --background output\kids_daily_routine_updated.blend --python scripts\07_export_web_assets.py
```
