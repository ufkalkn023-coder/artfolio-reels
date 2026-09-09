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
npm run reels:audit
npm run --silent reels:audit -- --json
npm run reels:audit -- --deep --reel <reel-id>
npm run reels:history:bootstrap -- met_853157 met_437311 met_436975 met_438159
npm run music:analyze -- --reel met_698749
npm run dev
npm run render -- starry-night
npm run qc -- starry-night
npm run package -- <reel-id>
npm run package -- <reel-id> --overwrite
npm run reels:verify-release -- <release-path-or-id>
npm run --silent reels:verify-release -- <release-path-or-id> --json
npm run render -- why-this-works
npm run qc -- why-this-works
npm run render:legacy
```

`render` writes H.264 MP4 files to `output/renders/` and refuses to overwrite an existing file unless `--overwrite` is passed. `qc` writes intro, middle, outro stills and a contact sheet to `output/qc/<template-id>/`. Add `--debug-targets` to QC only to overlay each selected detail's focal crosshair or target region, ID, and safe scale; this flag only writes stills and never appears in a normal MP4.

`package` copies an already-rendered Reel, canonical caption, validated ReelData metadata, and QC contact sheet into `output/releases/<reel-id>/`. It never renders or generates visual artifacts. A package contains `reel.mp4`, `caption.txt`, `metadata.json`, `manifest.json`, and `qc/contact-sheet.png`; the manifest includes SHA-256 hashes. Existing releases are refused unless `--overwrite` is supplied. Covers are excluded because the golden baseline has no independent post-render cover artifact.

`reels:verify-release` revalidates an existing release without changing it. It checks the manifest shape, every listed SHA-256 hash, source ReelData identity and metadata parity, and the packaged MP4's H.264 codec, 1080 × 1920 dimensions, 30 FPS, duration, and required audio stream. Add `--deep` for full decode and selected-audio audibility validation; add `--json` for machine-readable output.

`reels:audit` is a read-only reconciliation of production history, `data/reels`, rendered MP4s, social copy, QC evidence, and release packages. The default fast pass probes media metadata; `--deep` adds full decode and selected-audio audibility checks. Use `--reel <id>` to limit a deep pass and `npm run --silent reels:audit -- --json` for JSON-only stdout. The command reports discrepancies and orphans but never repairs or mutates history or artifacts.

`plan` validates a confirmed-rights artwork handoff, uses a cached plan from `data/plans/<canonical-id>.json` when available, and writes deterministic V2 `ReelData` to `data/reels/<canonical-id>.json`. It makes one Gemini call only on a true cache miss; malformed, unreadable, or schema-incompatible caches fail closed unless `--force-plan` explicitly bypasses the cache. Set `GEMINI_API_KEY`, optionally `GEMINI_MODEL`, and optionally `GEMINI_THINKING_LEVEL` (`low`, `medium`, or `high`; default `high`) for a live plan. Gemini requests default to a 120-second timeout, a 20 MiB artwork limit, and a 2 MiB response limit; `ARTFOLIO_GEMINI_TIMEOUT_MS`, `ARTFOLIO_GEMINI_MAX_ARTWORK_BYTES`, and `ARTFOLIO_GEMINI_MAX_RESPONSE_BYTES` provide validated positive-integer overrides. New live responses append count-only usage and estimated cost telemetry to the ignored `data/telemetry/planner-usage.jsonl`; cached plans make zero Gemini calls and add no charge. Use the bundled networkless Starry Night fixture with `--mock`. Add `--force-plan` to bypass the cache.

`reel` is the end-to-end local handoff command: it validates, plans or reuses the cache, compiles visual-only V2 ReelData, and runs visual QC. Only after QC succeeds does it derive a deterministic `MusicIntent` from the completed Reel, select an accepted production-ready AFM track, and enrich the saved ReelData. Add `--render` to render that final data once; `--render` never regenerates a plan. Both `reel` and `plan` support `--force-plan`.

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
Within one batch, accepted candidates share one Remotion bundle and Chrome instance for sequential QC; final renders remain isolated in the existing validated render command. Batch manifests include an additive operational summary with accepted, QC-passed, rendered, failed, shortfall, retained/cleaned QC artifact, and render-failure counts.

Set `ARTFOLIO_QC_RETENTION` to `all`, `summary`, or `none` (default `all`, preserving existing behavior). QC always renders full-resolution decision stills in a unique staging run. `summary` retains only a downscaled contact sheet and `qc-summary.json`; `none` retains no successful QC artifact. Failed runs preserve their partial evidence under `output/qc/.failures/`, and a successful rerun atomically replaces only that Reel's prior QC directory.

## AFM soundtrack integration

The production order is deliberately **Reel-first, music-second**:

```text
handoff → eligibility/assets → Gemini plan → acceptance → visual ReelData
→ visual QC → completed-Reel MusicIntent → AFM selection → music enrichment
→ one final render → video/audio validation → history/release metadata
```

Planner music suggestions remain readable for legacy caches and social-copy compatibility, but they are not the final soundtrack source of truth. AFM selection receives only completed `ReelData`, the accepted local catalog, and Reel production history. It scores semantic, family/subfamily, pacing, energy, motion, duration, recent-use, and total-use fit with deterministic ID tie-breaking. Tracks used in the latest 12 Reels are excluded when possible and receive penalties when the entire candidate set is recent.

Only AFM metadata marked `ACCEPTED` and `PRODUCTION_READY` with a validated `accepted/<AFM-ID>.wav` master is eligible. Masters remain untouched. Remotion receives `public/reel-audio/<AFM-ID>.wav` as a hard link and the directory is ignored by Git. External symlinks are not used because Remotion's public bundle does not copy them; if hard linking is unavailable (including cross-filesystem roots), music is skipped rather than duplicating the master. If AFM is absent, visual planning and QC continue and the final Reel may render without music. A missing explicitly forced track is an error.

`music:analyze -- --reel <id>` performs a read-only, networkless diagnostic pass without rendering. It reports completed-Reel intent, catalog-independent ideal family and first-pass subfamily rankings, current catalog coverage, recent exclusions and penalties, every available track score, the selected track, and the catalog-aware reason. Use `--file <path>` for an explicit ReelData file and add `--json` for structured output. For JSON-only stdout suitable for piping, use `npm run --silent music:analyze -- --reel <id> --json`.

`music:analyze -- --all` validates and analyzes every JSON ReelData file under the production `data/reels/` convention. It aggregates ideal family/subfamily demand, score margins, current catalog coverage and fallback rates, read-only hypothetical selections, concentration, the fixed 22-subfamily pilot priority, a deterministic listening set, ambiguous Reels, intent outliers, and Reel-corpus representation gaps. Invalid ReelData is skipped and reported without aborting the corpus. Use `npm run --silent music:analyze -- --all --json` for JSON-only stdout. Corpus analysis does not call Gemini, use the network, render, localize AFM audio, or write ReelData, production history, or AFM files.

Environment variables:

- `ARTFOLIO_AFM_ROOT`: AFM root override; defaults to `~/Developer/Artfolio-Music-Library`.
- `ARTFOLIO_AFM_TRACK_ID`: debug-only forced accepted track, applied after visual QC.
- `ARTFOLIO_MUSIC_VOLUME`: final soundtrack volume, default `0.18`.
- `ARTFOLIO_MUSIC_FADE_IN_SECONDS`: fade-in duration, default `0.6`.
- `ARTFOLIO_MUSIC_FADE_OUT_SECONDS`: fade-out duration, default `1.5`.

Music creation and downloading remain manual: generate/download in Flow Music, then run `afm ingest AFM-XXXX-XX`. The Reels generator performs no browser automation, generation, downloading, or AFM master modification.

`data/reel-production-history.json` is Remotion's ignored, durable Reel-only
production ledger. It records `QC_PASSED` for successful non-rendered batches
and `RENDERED` only after the validated MP4 completes; neither status means a
Reel was published. Entries may include the selected `musicTrackId` and
`musicSubfamily`; this same ledger drives soundtrack reuse penalties. Its complete canonical-ID set prevents automatic reselection,
and Remotion passes only that canonical-ID exclusion set to Art Bot acquisition
so produced handoffs cannot satisfy usable-pool capacity. Art Bot still uses
only its latest 12 entries for artist/museum diversity.
Use `reels:history:bootstrap` only to import an existing validated ReelData/MP4
pair without invoking Gemini, QC, or rendering.

Available V2 template IDs: `look-closer`, `three-details`, `inside-the-painting`, `one-artwork`, `why-this-works`, and `two-works-one-idea`.
