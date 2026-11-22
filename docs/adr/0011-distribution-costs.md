# 0011 Distribution, signing and the real costs of "free"
**Status**: **accepted** as recommended (2026-11-22; owner decision relayed by the work manager)

**Context.** The software costs nothing to use, but distribution has fixed costs that must be paid by someone.

| Item | Cost (approx.) | Needed for | Options |
|---|---|---|---|
| Domain + static hosting | ~$15/yr + free tier | web app, docs, model/asset downloads | Vercel/Cloudflare Pages free tiers; model files on GitHub Releases or a CDN with free egress for OSS |
| Apple Developer Program | $99/yr | iOS App Store, macOS notarization | pay; or ship macOS unsigned (users must override Gatekeeper) and iOS via PWA only |
| Google Play developer | $25 once | Play Store | pay; or distribute APK from GitHub/F-Droid |
| Windows code signing | free for OSS via SignPath Foundation, or ~$100-400/yr | no SmartScreen warnings | apply to SignPath OSS; or Azure Trusted Signing |
| CI minutes | free for public repos; macOS/Windows runners limited | release builds | public repo (free), or self-hosted runners |
| Legal review of codecs/licences | one-off | 1.0 | volunteer counsel / software-freedom org |

**Decision.** Public repo (free CI), Vercel/Cloudflare free static hosting, SignPath OSS for Windows, store fees (Apple $99/yr, Google Play $25) paid later from donations/sponsors, and a visible cost ledger in the repo. Until funded: the PWA is the mobile app and desktop builds are unsigned, with clear install instructions.
