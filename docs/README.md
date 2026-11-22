# OverCut docs

Start here, in this order:
1. [PRODUCT.md](PRODUCT.md): what we are building and the principles that settle arguments.
2. [FEATURES.md](FEATURES.md): everything the editor will do, with IDs (`TL-03`, `AI-07`, ...), priority, milestone and CapCut parity.
3. [ROADMAP.md](ROADMAP.md): milestones M0 to M9 and what "done" means for each.
4. [ARCHITECTURE.md](ARCHITECTURE.md): how it is built, which module owns what.
5. [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md): what to do first (risk-first spikes), the first issues, how work flows.
6. [PERFORMANCE.md](PERFORMANCE.md) and [QUALITY.md](QUALITY.md): budgets, tests, accessibility, privacy, release gates.
7. [adr/](adr/): architecture decision records, plus the list of decisions still open.

`docs/features/<feature>.md` holds per-feature rules; it is created together with the feature (see `CLAUDE.md`).

Conventions: feature IDs are stable (never reused). Priorities: **P0** must exist for 1.0 to be called an alternative to CapCut, **P1** expected by 1.0, **P2** after 1.0, **P3** ideas. Milestones M0 to M9 are defined in the roadmap.
