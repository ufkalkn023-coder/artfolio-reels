# Artfolio Reels V2

The V2 compositions are data-driven 1080 × 1920 / 30 fps Reels built from a shared scene, camera, text, timing and template system. The original 60-second `ArtfolioReel` remains available as the legacy composition.

## Commands

```console
npm run validate
npm run plan -- data/handoffs/starry-night.json --mock
npm run reel -- data/handoffs/starry-night.json
npm run reel -- data/handoffs/starry-night.json --render
npm run reels:batch
npm run reels:batch -- --render
npm run reels:batch -- --selection-only
npm run reels:history:bootstrap -- met_853157 met_437311 met_436975 met_438159
npm run dev
npm run render -- starry-night
npm run qc -- starry-night
npm run render -- why-this-works
npm run qc -- why-this-works
npm run render:legacy
```

`render` writes H.264 MP4 files to `output/renders/` and refuses to overwrite an existing file unless `--overwrite` is passed. `qc` writes intro, middle, outro stills and a contact sheet to `output/qc/<template-id>/`. Add `--debug-targets` to QC only to overlay each selected detail's focal crosshair or target region, ID, and safe scale; this flag only writes stills and never appears in a normal MP4.

`plan` validates a confirmed-rights artwork handoff, uses a cached plan from `data/plans/<canonical-id>.json` when available, and writes deterministic V2 `ReelData` to `data/reels/<canonical-id>.json`. It makes one Gemini call only on a cache miss; set `GEMINI_API_KEY`, optionally `GEMINI_MODEL`, and optionally `GEMINI_THINKING_LEVEL` (`low`, `medium`, or `high`; default `high`) for a live plan. New live responses append count-only usage and estimated cost telemetry to the ignored `data/telemetry/planner-usage.jsonl`; cached plans make zero Gemini calls and add no charge. Use the bundled networkless Starry Night fixture with `--mock`. Add `--force-plan` to bypass the cache.

`reel` is the end-to-end local handoff command: it validates, plans or reuses the cache, compiles V2 ReelData, and runs QC. Add `--render` only after QC to run the existing H.264 render validation; `--render` never regenerates a plan. Both `reel` and `plan` support `--force-plan`.

`reels:batch` is the production orchestration owner. It invokes the Art Bot's
local `python -m src.reel_batch_candidates` boundary to obtain a deterministic,
rights-safe queue, then runs the existing cache/planner, acceptance gate, QC,
and optional render stages one candidate at a time. `REEL_SELECTION_TARGET`
is the only target setting (default `4`); `REEL_BATCH_CANDIDATE_LIMIT` sets
the backup queue depth (default `8`, minimum target). Rejected or failed items
advance the queue. A shortfall is reported rather than retried indefinitely.
The ignored manifest is written to `output/reel-batches/<run-id>.json` and
contains safe per-item outcomes plus aggregate Gemini usage/cost and timings.
Set `ARTFOLIO_ART_BOT_ROOT` only when the Art Bot is not the sibling project.

`data/reel-production-history.json` is Remotion's ignored, durable Reel-only
production ledger. It records `QC_PASSED` for successful non-rendered batches
and `RENDERED` only after the validated MP4 completes; neither status means a
Reel was published. Its complete canonical-ID set prevents automatic reselection,
and Remotion passes only that canonical-ID exclusion set to Art Bot acquisition
so produced handoffs cannot satisfy usable-pool capacity. Art Bot still uses
only its latest 12 entries for artist/museum diversity.
Use `reels:history:bootstrap` only to import an existing validated ReelData/MP4
pair without invoking Gemini, QC, or rendering.

Available V2 template IDs: `look-closer`, `three-details`, `inside-the-painting`, `one-artwork`, `why-this-works`, and `two-works-one-idea`.
