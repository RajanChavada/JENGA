# Real-footage test suite (Pexels)

Six real, license-free clips pulled from Pexels (search: "asphalt paving", a
general construction search, "dump truck", "road line painting", "tunnel
boring"), downscaled to 720p, paired with matching or deliberately mismatched
PDF reports. Unlike the AI-generated scenarios in `video-prompts.txt`, these
are genuinely unscripted footage — the mismatches below are real properties of
the clips, not engineered.

Submit each pair together (PDF + video) against the named ticket, as
contractor, then review as owner.

| # | Video | Report | Ticket | What the footage actually shows | Expected |
|---|---|---|---|---|---|
| 1 | `videos/segment-a-paving-supported.mp4` | `reports/pexels-1-paving-supported.pdf` | Segment A Paving (km 0-1) | Asphalt paver actively laying hot-mix, a dump truck feeding the hopper | `in_progress`, claim supported |
| 2 | `videos/segment-a-paving-supported.mp4` (same clip, different report) | `reports/pexels-2-paving-contradicted.pdf` | Segment A Paving (km 0-1) | Same clip — paving is actively underway, not finished/cured, and only one pass is visible | `contradicted` — report claims "complete... both lanes... cured"; footage shows active laying only. This ticket feeds Line Painting & Signage, so expect a **fork proposal**. |
| 3 | `videos/grading-supported.mp4` | `reports/pexels-3-grading-supported.pdf` | Height Clearance & Grading | Backhoe excavating/trenching on a subdivision site; overhead power lines visible in frame | `in_progress`, claim supported. (Real footage is trench excavation, not roadbed grading specifically — a good honest near-miss, not an exact match.) |
| 4 | `videos/truck-logistics-partial.mp4` | `reports/pexels-4-trucking-contradicted.pdf` | Truck Logistics Scheduling | A dump truck already actively unloading/dumping soil | `contradicted` or `partial` — report claims trucks are merely "staged and on standby"; footage shows a truck already working, past the staging stage. |
| 5 | `videos/line-painting-supported.mp4` | `reports/pexels-5-painting-supported.pdf` | Line Painting & Signage | Close-up of freshly painted yellow + blue lines on asphalt | `in_progress`/`complete`, claim supported |
| 6 | `videos/tunnel-not-visible.mp4` | `reports/pexels-6-launch-prep-not-visible.pdf` | Revenue Service Launch Prep (Eglinton Crosstown LRT project) | Real underground tunnel-boring-phase construction — completely unrelated to final launch-readiness activities | `not_visible` on every finding; no proposals. Genuine domain mismatch, not contrived. |

Notes:
- Scenario 6 is the only one against the Eglinton project — its
  "Revenue Service Launch Prep" ticket is already seeded `in_progress`, so no
  setup is needed beyond picking that project in the switcher.
- Scenarios 1 and 2 intentionally reuse the same clip to isolate the
  contradiction to the report text alone, mirroring the AI-generated
  scenario A/B pair in `video-prompts.txt`.
- All clips re-encoded to 720p/H.264 with `ffmpeg` (originals were up to 4K/135MB) —
  Gemini resamples internally regardless of source resolution, so this only
  saves upload time and disk space, not analysis quality.
