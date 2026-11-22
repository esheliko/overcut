# 0005 Local-first, no backend
**Status**: proposed

**Context.** "Completely free" cannot rely on servers that cost money per user, and privacy is a product principle.

**Decision.** There is no Overcut backend for editing. Projects and media live on the device (OPFS or the file system). The web app is static files; model files and the optional free media library index are static downloads on a CDN-capable host. Sync, sharing and collaboration (M8) are peer-to-peer or through storage the user already owns; any relay is a stateless, tiny, self-hostable component and never required.

**Consequences.** (+) near-zero running cost, offline by default, nothing to breach. (-) no built-in cloud backup (bring-your-own-storage covers it), no server-side rendering or hosted templates marketplace, collaboration is harder; browser storage quotas and eviction must be handled explicitly (persistent storage requests, clear warnings, export/backup prompts).
