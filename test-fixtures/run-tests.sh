#!/bin/bash
# Runs the 6 real-footage scenarios from pexels-test-suite.md end-to-end against
# a running `npm run dev` (localhost:3000) and a seeded DB. For each scenario:
# uploads the video, submits the matching PDF report, polls analysis until it
# finishes, and prints the result next to the expected outcome.
#
# ponytail: testing shortcut, not the real demo flow — PATCHes target tickets
# straight to 'in_progress' rather than walking the DAG's actual unblock chain
# (Site Survey -> Grading -> Segment A/B -> Painting). Fine for exercising the
# video pipeline in isolation; use the UI's real flow for an actual demo.
set -euo pipefail
cd "$(dirname "$0")/.."
BASE="http://localhost:3000"
FIXTURES="test-fixtures"

json() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log($1)}catch(e){console.error('parse failed:',s);process.exit(1)}})"; }

echo "== Resolving projects/branches/tickets =="
ROUTE12_ID=$(curl -s "$BASE/api/projects" | json "JSON.parse(s).find(p=>p.NAME==='Route 12 Resurfacing').ID")
EGLINTON_ID=$(curl -s "$BASE/api/projects" | json "JSON.parse(s).find(p=>p.NAME==='Line 5 Eglinton Crosstown LRT').ID")
ROUTE12_BRANCH=$(curl -s "$BASE/api/branches?projectId=$ROUTE12_ID" | json "JSON.parse(s).find(b=>!b.FORKED_FROM_BRANCH_ID).ID")
EGLINTON_BRANCH=$(curl -s "$BASE/api/branches?projectId=$EGLINTON_ID" | json "JSON.parse(s).find(b=>!b.FORKED_FROM_BRANCH_ID).ID")

ticket_id() { # $1=branchId $2=title
  curl -s "$BASE/api/graph?branchId=$1" | json "JSON.parse(s).tickets.find(t=>t.TITLE==='$2').ID"
}

SEGMENT_A=$(ticket_id "$ROUTE12_BRANCH" "Segment A Paving (km 0-1)")
GRADING=$(ticket_id "$ROUTE12_BRANCH" "Height Clearance & Grading")
TRUCKING=$(ticket_id "$ROUTE12_BRANCH" "Truck Logistics Scheduling")
PAINTING=$(ticket_id "$ROUTE12_BRANCH" "Line Painting & Signage")
LAUNCH_PREP=$(ticket_id "$EGLINTON_BRANCH" "Revenue Service Launch Prep")

echo "== Forcing target tickets to in_progress (testing shortcut) =="
for t in "$SEGMENT_A" "$GRADING" "$TRUCKING" "$PAINTING"; do
  curl -s -X PATCH "$BASE/api/tickets/$t" -H "Content-Type: application/json" -d '{"status":"in_progress"}' > /dev/null
done
# Revenue Service Launch Prep is already seeded in_progress — no patch needed.

submit() { # $1=ticketId $2=videoFile $3=pdfFile $4=label
  local ticketId=$1 video=$2 pdf=$3 label=$4
  echo
  echo "== Scenario: $label =="
  local mediaId
  mediaId=$(curl -s -X POST "$BASE/api/media" \
    -F "file=@$FIXTURES/videos/$video;type=video/mp4" \
    -F "projectId=$ROUTE12_ID" -F "branchId=$ROUTE12_BRANCH" -F "ticketId=$ticketId" \
    | json "JSON.parse(s).id")
  # (projectId/branchId above is harmless even for the Eglinton scenario's media
  # row — analysis keys off ticketId's own branch_id already set at upload time
  # via media-store; adjust below for scenario 6 specifically.)
  curl -s -X POST "$BASE/api/reports" \
    -F "ticketId=$ticketId" -F "pdf=@$FIXTURES/reports/$pdf;type=application/pdf" -F "mediaId=$mediaId" \
    > /dev/null

  echo "Uploaded (mediaId=$mediaId). Polling analysis..."
  for i in $(seq 1 30); do
    result=$(curl -s "$BASE/api/media/$mediaId/analysis")
    status=$(echo "$result" | json "JSON.parse(s).status")
    if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
      echo "$result" | json "JSON.stringify(JSON.parse(s), null, 2)"
      break
    fi
    sleep 3
  done
}

# Scenarios 1 & 2 share a clip on purpose — see pexels-test-suite.md.
submit "$SEGMENT_A" "segment-a-paving-supported.mp4" "pexels-1-paving-supported.pdf" \
  "1 - Paving, supported (expect: in_progress, claim supported)"
submit "$SEGMENT_A" "segment-a-paving-supported.mp4" "pexels-2-paving-contradicted.pdf" \
  "2 - Paving, contradicted (expect: contradicted claim -> fork proposal)"
submit "$GRADING" "grading-supported.mp4" "pexels-3-grading-supported.pdf" \
  "3 - Grading, supported (expect: in_progress, claim supported)"
submit "$TRUCKING" "truck-logistics-partial.mp4" "pexels-4-trucking-contradicted.pdf" \
  "4 - Trucking, contradicted (expect: contradicted/partial - truck already unloading, not staged)"
submit "$PAINTING" "line-painting-supported.mp4" "pexels-5-painting-supported.pdf" \
  "5 - Painting, supported (expect: claim supported)"

echo
echo "== Scenario: 6 - Launch prep, not_visible (expect: not_visible, no proposals) =="
mediaId=$(curl -s -X POST "$BASE/api/media" \
  -F "file=@$FIXTURES/videos/tunnel-not-visible.mp4;type=video/mp4" \
  -F "projectId=$EGLINTON_ID" -F "branchId=$EGLINTON_BRANCH" -F "ticketId=$LAUNCH_PREP" \
  | json "JSON.parse(s).id")
curl -s -X POST "$BASE/api/reports" \
  -F "ticketId=$LAUNCH_PREP" -F "pdf=@$FIXTURES/reports/pexels-6-launch-prep-not-visible.pdf" -F "mediaId=$mediaId" \
  > /dev/null
echo "Uploaded (mediaId=$mediaId). Polling analysis..."
for i in $(seq 1 30); do
  result=$(curl -s "$BASE/api/media/$mediaId/analysis")
  status=$(echo "$result" | json "JSON.parse(s).status")
  if [ "$status" = "done" ] || [ "$status" = "failed" ]; then
    echo "$result" | json "JSON.stringify(JSON.parse(s), null, 2)"
    break
  fi
  sleep 3
done

echo
echo "== Done. Compare each result's ticketFindings/claimChecks/proposals against"
echo "   test-fixtures/pexels-test-suite.md's Expected column. =="
