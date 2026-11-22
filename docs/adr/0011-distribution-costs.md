# 0011 Distribution, signing and the real costs of "free"
**Status**: **open: owner decision** (blocks M5 store work; web and desktop alpha need no decision)

**Context.** The software costs nothing to use, but distribution has fixed costs that must be paid by someone.

| Item | Cost (approx.) | Needed for | Options |
|---|---|---|---|
| Domain + static hosting | ~$15/yr + free tier | web app, docs, model/asset downloads | Vercel/Cloudflare Pages free tiers; model files on GitHub Releases or a CDN with free egress for OSS |
| Apple Developer Program | $99/yr | iOS App Store, macOS notarization | pay; or ship macOS unsigned (users must override Gatekeeper) and iOS via PWA only |
| Google Play developer | $25 once | Play Store | pay; or distribute APK from GitHub/F-Droid |
| Windows code signing | free for OSS via SignPath Foundation, or ~$100-400/yr | no SmartScreen warnings | apply to SignPath OSS; or Azure Trusted Signing |
| CI minutes | free for public repos; macOS/Windows runners limited | release builds | public repo (free), or self-hosted runners |
| Legal review of codecs/licences | one-off | 1.0 | volunteer counsel / software-freedom org |

**Recommendation.** Public repo (free CI), Vercel/Cloudflare free static hosting, SignPath OSS for Windows, pay the two small store fees from donations/sponsors, keep a visible cost ledger in the repo. Until funded: PWA is the mobile app and desktop builds are unsigned with clear instructions.
