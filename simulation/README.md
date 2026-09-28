# Kids Daily Movement Routine Simulation

Blender 5.2 village-day simulation that animates children moving between six locations on a timed schedule, with an on-screen tracking HUD (location + activity).

## Locations

| ID | Label | Map position |
|----|-------|--------------|
| `LOC_Home` | Home | Center-west |
| `LOC_School` | School | North |
| `LOC_Farm` | Farm | East |
| `LOC_Shops` | Shops | South |
| `LOC_Wood` | Fetching Wood | Northwest |
| `LOC_Well` | Water Well | Southwest |

## Project layout

```
assets/          Drop .blend / .fbx / .glb / .obj models here
  characters/
  locations/
  props/
scripts/         Build pipeline (01 → 05)
data/            daily_schedule.json
output/          kids_daily_routine.blend
```

## Build (headless)

Requires **Blender 4.2 LTS** (Microsoft Store or portable). The project was rebuilt for 4.2 — files saved from Blender 5.x will not open in 4.2.

```powershell
# Using the portable copy under tools/ (if present):
& ".\tools\blender-4.2.9-windows-x64\blender.exe" --background --python scripts/build_all.py

# Or your installed Blender 4.2:
& "$env:LOCALAPPDATA\Microsoft\WindowsApps\blender-launcher.exe" --background --python scripts/build_all.py
```

Then open `output/kids_daily_routine.blend` in Blender 4.2. When prompted about Auto-Run scripts, choose **Allow** (needed for the tracking HUD).

## Realistic character animation

Kids use Quaternius CC0 FBX rigs (see `assets/characters/CREDITS.txt`) with NLA clips synced to the day schedule:

| Segment | Clip |
|---------|------|
| Travel | `Walk` (or `Walk_Carry` when fetching water/wood) |
| School | `SitDown` then `Idle` |
| Chores / farm / market | `PickUp` loop |
| Rest / evening / lunch | `Idle` loop |

Character files: `kid_01_amina.fbx`, `kid_02_kofi.fbx`, `kid_03_sena.fbx`.

## Importing your own 3D files

Place files under `assets/` using name hints:

- `home*`, `house*` → Home
- `school*` → School
- `farm*`, `field*` → Farm
- `shop*`, `market*` → Shops
- `wood*`, `forest*`, `tree*` → Wood
- `well*`, `water*` → Well
- Replace `kid_0N_*.fbx` to swap a character (keep Walk / Idle / Walk_Carry actions)

Re-run `build_all.py` after adding assets.

## Schedule

Edit `data/daily_schedule.json` to change kids, times, locations, and activities. Clock hours map to frames with `frames_per_hour` (default 60 at 24 fps).

## Playback

1. Open `output/kids_daily_routine.blend`
2. When Blender warns about Auto-Run scripts, choose **Allow** (needed for the tracking HUD / sidebar). You can also enable *Edit → Preferences → Save & Load → Auto Run Python Scripts*.
3. Use camera `CAM_Overview` for the tracking map view (or the **Kids Sim** sidebar tab)
4. Scrub or play the timeline — HUD text updates location/activity per kid

Frame range covers **06:00–20:00** at 90 frames/hour (24 fps) for smoother travel.

## Visual quality

Characters get a quality pass (`06_quality_pass.py`):
- 2048×2048 detail albedo maps (skin / fabric / hair)
- Subdivision Surface (viewport 1 / render 2)
- Skin subsurface scattering, fabric sheen, bump detail
- EEVEE at 1920×1080 with higher AA / AO / shadows
