# 0009 Licence
**Status**: **accepted** (2026-11-22; owner delegated the decision to the work manager)

**Context.** "Completely free for everyone" and "not locked behind a vendor" both point to open source; the choice decides whether others may take the code into proprietary products.

**Options.**
1. **GPL-3.0-or-later (apps) + MIT/Apache-2.0 (engine crates and file-format libs)**: strong copyleft for the product, permissive for reusable parts that grow the ecosystem (format, CLI library).
2. **AGPL-3.0-or-later (everything)**: also closes the "hosted modified copy" loophole; some contributors and companies avoid it.
3. **MPL-2.0**: file-level copyleft, easy to combine with other code; weaker protection against closed forks.
4. **MIT/Apache-2.0 (everything)**: maximum adoption; allows a closed competitor to repackage it.

**Constraints to check.** FFmpeg LGPL dynamic linking is compatible with all of the above; openh264 is a separate binary; app-store distribution of GPL code needs care (Apple App Store terms vs GPLv3 are contested: AGPL/GPL on iOS often needs the owner as sole copyright holder to add an exception, hence a CLA or DCO policy decision).

**Decision.** Option 1.
- **Apps** (`apps/*`, and repo tooling/docs by default): GPL-3.0-or-later.
- **Engine crates** (`crates/*`) and **shared packages** (`packages/*`): MIT OR Apache-2.0. Permissive code may flow into the GPL apps, never the reverse.
- **DCO sign-off, no CLA** (`CONTRIBUTING.md`). Contributors keep their copyright.
- **"No feature gating, ever"** is a written commitment in `docs/GOVERNANCE.md` (stub; full governance stays open in ADR 0014).
- Files: `LICENSE` (explains the split), `LICENSE-GPL`, `LICENSE-MIT`, `LICENSE-APACHE`; `license` fields set in every `Cargo.toml` and `package.json`.

**Open caveat.** Apple App Store terms vs GPLv3 are contested; with a DCO and many copyright holders we cannot add a store exception later. Revisit before iOS store distribution (ADR 0011); if needed, the engine crates are already permissive and the iOS app UI would need relicensing consent from contributors, so keep early external contributions to the apps small.
