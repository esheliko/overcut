# Process lessons log (history)

Why a process mechanism looks the way it does, written when something went wrong or a rule was decided. Newest at the bottom. Keep it short: date, what happened, what the rule is now.
2026-11-23: two usage limits hit in 11 hours (13 workers in 35 min, 6 died at the wall). Rule now: max 3 workers counting resumed, handoff at ~200k, never wake an idle (over 1 h) big session. Auto-merge is impossible on this repo (no branch protection, free plan).
