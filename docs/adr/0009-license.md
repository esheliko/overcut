# 0009 Licence
**Status**: **open: owner decision** (blocks accepting external contributions and publishing the repo publicly)

**Context.** "Completely free for everyone" and "not locked behind a vendor" both point to open source; the choice decides whether others may take the code into proprietary products.

**Options.**
1. **GPL-3.0-or-later (apps) + MIT/Apache-2.0 (engine crates and file-format libs)**: strong copyleft for the product, permissive for reusable parts that grow the ecosystem (format, CLI library).
2. **AGPL-3.0-or-later (everything)**: also closes the "hosted modified copy" loophole; some contributors and companies avoid it.
3. **MPL-2.0**: file-level copyleft, easy to combine with other code; weaker protection against closed forks.
4. **MIT/Apache-2.0 (everything)**: maximum adoption; allows a closed competitor to repackage it.

**Constraints to check.** FFmpeg LGPL dynamic linking is compatible with all of the above; openh264 is a separate binary; app-store distribution of GPL code needs care (Apple App Store terms vs GPLv3 are contested: AGPL/GPL on iOS often needs the owner as sole copyright holder to add an exception, hence a CLA or DCO policy decision).

**Recommendation.** Option 1 with a DCO (no CLA) and a written "no feature gating, ever" commitment in the governance doc, unless iOS store distribution advice says otherwise. Until decided: all rights reserved, no external PRs merged.
