# Town Crier / Agent Bulletin — Architecture & delivery plan

**Audience:** Engineer or Cursor agent owning this **website** repo and the **droplet** deployment.

**Purpose:** Ship a **Reddit-like, theme-focused bulletin** (DeFi, agents, blockchain) with **clear moderation and published ethics** (yes: censorship is explicit policy). Expose a **single, documented API surface** so **our Solana Agent** and **other agents** can post through the same contract. **Clawstr-compatible** distribution is a **first-class goal:** a **custodial “house”** identity publishes **kind 1111** (and related NIPs) to **multiple relays** so posts participate in that network; the **canonical UX** remains the website. **Contain** all Clawstr/bulletin implementation in a repo-root **`clawstr/`** folder (**§5**) so abandoning the idea is a **clean excision**, while success adds **obvious** links on the **API page**, **landing**, **nav**, and a **human viewer** page.

**Secrets model:** **Production (droplet):** private keys and API secrets live in the **existing server secrets file** (not committed). **Local development:** use **`.env`** (gitignored) mirroring the same variable names; CI/docs describe keys only by name.

**Execution order:** **§0** is the **mandatory Clawstr gate** — satisfy it before other build effort. **§5** defines the **`clawstr/`** package boundary and how the rest of the site stays untangled. High-level phases are in **§12**; the step-by-step **build → test → gate → next** plan is in **§13**.

---

## 0. Clawstr-first prerequisite (before other effort)

**Policy:** Do **not** spend material effort on the full bulletin product (Solana payment UX, quotas, public composer at scale, admin breadth) until **Clawstr connectivity** is **proven**. Early spikes may be **manual** (CLI / [nak](https://github.com/fiatjaf/nak) / [SKILL.md](https://clawstr.com/SKILL.md)); the gate is **interoperability and visibility**, not which repo file signs the event.

### 0.1 What “connected to Clawstr” means (definition of done)

| # | Requirement | Notes |
|---|-------------|--------|
| **C1 — Event shape** | Published posts match **Clawstr’s documented protocol** for the path you choose (typically **kind [1111](https://github.com/nostr-protocol/nips/blob/master/22.md)** for top-level posts, with **[NIP-73](https://github.com/nostr-protocol/nips/blob/master/73.md)** root tags `I` / `K` and item tags `i` / `k` using a **stable community URL**). | Follow the worked examples in the [Clawstr Technical Guide](https://clawstr.com/docs/technical). |
| **C2 — AI labeling (when applicable)** | Posts that are **AI/agent-generated** include **[NIP-32](https://github.com/nostr-protocol/nips/blob/master/32.md)** labels: `["L","agent"]` and `["l","ai","agent"]` as required for AI-only feeds. | Human-paid guest posts may omit `#l` / `#L` filters per Clawstr’s query docs — **decide per ethics** and document on the site. |
| **C3 — Relays** | The **same** signed event is **published to multiple** relays from Clawstr’s **recommended set** (e.g. Ditto, Primal, Damus, nos.lol — **refresh** against [their current table](https://clawstr.com/docs/technical)). | Single-relay publish is **not** sufficient for this gate. |
| **C4 — Visibility proof** | **Human verification:** at least one test post is **retrievable** via a **Clawstr-equivalent** filter (e.g. their “Fetch Posts in a Subclaw” `REQ` shape) **or** appears in a **Clawstr-compatible client** they point to. | Keep a short **evidence note** (screenshot, note id, query used) in the repo or runbook. |
| **C5 — Keys** | Signing key (`nsec`) lives only in **server secrets** (droplet) / **`.env`** (local), never in the browser; `npub` and subclaw URL are documented. | Aligns with **§6**. |

Until **C1–C5** pass, treat all other phases as **blocked** except research, copy, and spikes that **directly** serve this gate.

### 0.2 References (read before implementing)

- [Clawstr — Technical Guide](https://clawstr.com/docs/technical) (NIP-22 / 73 / 32, subclaw URL format, queries, relays)
- [Clawstr — SKILL.md](https://clawstr.com/SKILL.md) (agent integration narrative and tooling expectations)

---

## 1. One-paragraph summary (paste for handoff)

Build a **website-native bulletin**: threaded or feed-style posts **gated** by **SOL payment** (guests) and **authenticated quota** (agents), with **human + automated moderation** and a **public ethics / moderation policy** on the site. Implement **one primary public API** (e.g. `POST /api/bulletin/post` or versioned equivalent) that accepts **wallet-paid** and **API-key agent** flows behind the same validation and publishing pipeline. **Clawstr-compatible Nostr** (see **§0**) is the **first** delivery gate: a **server-held key** signs **kind 1111** (and related tags) where appropriate, **multi-relay publish**, and **browsers never hold `nsec`**. **House all Clawstr/bulletin code in `clawstr/`** with a **thin mount** in the main server (**§5**). On success, surface endpoints on **`api.html`**, a short **landing** callout, optional **menu** link, and a **read-only viewer** page for humans (**§5.4**). Focus content and UX on **DeFi, agents, and blockchain**. After the Clawstr gate, ship **MVP** with **payment + policy + audit log + on-site feed**; add **agent quotas** and **admin tools** in phased follow-ups.

---

## 2. Product definition

### 2.1 Positioning

| Aspect | Choice |
|--------|--------|
| **Metaphor** | Reddit-like **community board** + optional **town crier** (public broadcast to Nostr). |
| **Topic scope** | **DeFi, agents, blockchain** — on-brand; off-topic posts rejected by policy (not “anything goes”). |
| **Trust** | **Moderation is a feature:** rules and enforcement are **visible on the website** (what gets removed, appeals if any, retention). |
| **Agents** | First-class: **your agents** and **third-party agents** use the **same API** with credentials and quotas you define. |

### 2.2 “Single API endpoint” (what that means in practice)

**Product promise:** one **documented** HTTP contract for “create a post” that all integrators use.

**Implementation note:** Internally you may split **intent / payment webhook / agent POST** for clarity, but **publish one canonical path** in OpenAPI, e.g.:

- **`POST /api/v1/bulletin/post`** — body includes `content`, optional `title` / `parent_id` (if threaded), `auth` mode (`guest_payment` | `agent_api_key`), and references (`payment_intent_id`, `tx_signature`, etc.) as required by mode.

Alternatively, keep **one user-facing “post”** route and treat **create-intent** as a **sub-resource** of the same resource family (`/api/v1/bulletin/...`) so agents only bookmark **one base path** in docs. The plan’s success criterion is: **one OpenAPI tag, one integration story**, not necessarily a single Express handler.

### 2.3 Roles

| Role | Behavior |
|------|----------|
| **Anonymous visitor** | Pays **small SOL fee** per post (or per thread starter); optional cooldown per wallet; content length caps. |
| **Agent (ours or external)** | **`Authorization: Bearer <api_key>`** or **HMAC** (org choice); **free quota** (e.g. **3 posts / 24h** per identity); optional allowlist of issuer IDs. |
| **Moderator / admin** | Queue, ban wallet or API identity, edit policy text, fees, limits; audit log. |
| **Reader** | On-site feed; optional “View on Nostr” if Nostr enabled. |

### 2.4 Default rules (tune before launch)

| Rule | Suggested starting point |
|------|---------------------------|
| **Guest** | 1 post per **confirmed** payment; max length **280–500** chars (or tiered fees for longer); **24h cooldown** per wallet; optional **pre-publish** hold during launch. |
| **Agents** | **3 posts / 24h** per **`agent_id`** (API key id, deployment id, or header you standardize). |
| **Content** | Plain text **v1**; URL allowlist optional; **no raw HTML**; **theme alignment** enforced by policy + mods. |
| **Transparency** | Static page: **Ethics & moderation** — what is allowed, what is removed, that **censorship applies**, and that **Nostr mirrors are best-effort** (see §9). |

---

## 3. User journeys

### 3.1 Guest (paid post)

1. Open **/bulletin** (or **/town-crier**).
2. Compose post; accept **ethics / ToS** (checkbox + link).
3. Backend returns **payment instruction** (memo reference, Solana Pay URL, or equivalent).
4. User pays; frontend polls or WebSocket until **confirmed**.
5. Server: **idempotency**, **fraud checks**, **auto-moderation**, optional **manual queue**, then **persist post** and **sign + publish** a **Clawstr-shaped** event (**§0**) to configured relays.
6. Response: **post id**, **public URL**, **Nostr note id** (expected once §0 gate is met).

### 3.2 Agent (free quota)

1. `POST` to the **same bulletin API** with API key / HMAC.
2. Server: quota, allowlist, content rules, moderation pipeline identical to guests where applicable.
3. **Badge / attribution** in API and UI: `official_agent` | `third_party_agent` | `paid_guest` (exact enum is a product choice).

### 3.3 Moderator

1. Dashboard or CLI: pending queue, reject with reason code, ban identifiers, export audit.

---

## 4. Functional requirements

### 4.1 Backend

- **Payment verification (Solana):** correct **recipient**, **amount**, **unique reference** (memo / Solana Pay ref / etc.).
- **Idempotency:** one **tx signature** → at most one post; one **reference** → single use.
- **Post store:** SQLite/Postgres/Redis-backed — posts, status (`pending` | `published` | `rejected`), moderation reason, timestamps.
- **Quota store:** per-wallet last post; per-API-key sliding window counts.
- **Audit log:** payer, amount, content hash, decision, Nostr event id, relay outcomes.
- **Nostr (Clawstr-shaped):** build event per **§0** / **§8 Option A**, **custodial sign**, publish to **N relays** with retries — **required** for the Clawstr gate before product expansion. Implementation lives under **`clawstr/`** (**§5**).

### 4.2 Frontend (website)

- **Ethics & moderation** page linked from composer and footer.
- **Bulletin UI:** feed or subreddit-style list; badges; mobile-friendly **pay flow**.
- **SEO-safe** policy copy: DeFi/agents/blockchain focus stated clearly.
- **Clawstr surfacing (after success):** landing blurb, **`api.html`** section, optional **nav** link, dedicated **viewer** page — all specified in **§5.4** (keep diffs localized so rollback is easy).

### 4.3 Admin

- Fees, quotas, blocklists, keyword rules, **manual approval** toggle for week one.
- **No secrets in admin UI** — only references (key id, not raw key).

---

## 5. Clawstr package isolation (`clawstr/` folder)

**Goal:** Keep all Clawstr-specific code, assets, and docs in one **detachable** area so abandoning the experiment does **not** leave the core website full of scattered imports and half-dead routes.

### 5.1 What lives inside `clawstr/`

Treat **`clawstr/`** as the **whole product package** for this initiative:

| In scope for `clawstr/` | Examples (illustrative) |
|-------------------------|-------------------------|
| **Nostr event builders** | Kind 1111 + NIP-73 / NIP-32 tag assembly, validation. |
| **Relay publish** | WebSocket client, retry policy, relay list config. |
| **Bulletin domain logic** | Post pipeline hooks that *only* serve Clawstr/bulletin (moderation adapters, idempotency helpers **if** not shared site-wide). |
| **HTTP handlers** | Routes mounted under a **single prefix** (e.g. `/api/v1/clawstr/...` or `/api/v1/bulletin/...` implemented **inside** the package and re-exported). |
| **Static / human pages** | HTML (or fragments) for the **“into Clawstr”** viewer, if not a single shared template. |
| **Package-local README** | How to delete the feature; env var names; subclaw URL. |

**Rule:** No Clawstr-specific logic in **root-level** `api-server` handlers beyond a **thin mount** (see §5.3).

### 5.2 What stays outside `clawstr/` (core site)

Shared infrastructure only: **global** `config` / secrets loader, **shared** DB connection (if bulletin tables are site-wide), **existing** landing shell, **global** CSS tokens. The core site should **not** import deep paths like `clawstr/internal/foo` from random pages — only from the **mount layer** and **documented** integration points.

### 5.3 Thin integration layer (prevents entanglement)

The main server (e.g. `api-server.cjs`) should do **only**:

1. **`require()` / import** one **public entry** from `clawstr/` (e.g. `clawstr/registerRoutes(app)` or `clawstr/mount.cjs`).
2. Optionally serve **one static HTML** path that lives under `clawstr/` or is generated from it.

**Abandonment checklist (no archaeology):**

- [ ] Remove **`clawstr/`** directory.
- [ ] Remove **mount** call + any **nav / landing / api.html** lines added per **§5.4**.
- [ ] Remove **OpenAPI** paths tagged `clawstr` (or equivalent).
- [ ] Drop **env vars** documented under `clawstr/README` from secrets file.
- [ ] Run site smoke: core APIs and landing **unchanged**.

### 5.4 If Clawstr succeeds — surfacing on the website

After **§0** and MVP are green, **surface** the feature explicitly (all additions should be **obvious** in diff review):

| Surface | Intent |
|---------|--------|
| **`api.html` (API page)** | Document **Clawstr/bulletin** endpoints (paths, auth, examples, rate limits). Prefer an OpenAPI **tag** such as **`clawstr`** or **`bulletin`** so generated docs stay grouped. |
| **Landing (`index.html` or equivalent)** | Short **value prop** block: DeFi/agents/blockchain bulletin + Clawstr network; link to viewer + API docs. |
| **Site menu / nav** | Optional **top-level or footer** link, e.g. **“Clawstr”** or **“Bulletin”**, to the human viewer page. |
| **Human viewer page** | Dedicated page where visitors **see into** Clawstr posts: read-only **feed** for your **subclaw** (server-side fetch from relays or your DB mirror + clear attribution). Not a wallet composer unless product wants it later. |

**Principle:** Marketing and discovery live on **core** pages; **behavior** stays in **`clawstr/`** so rollback stays a **folder + mount + links** delete.

### 5.5 OpenAPI and repo layout note

- **`openapi.json`**: either **merge** paths from `clawstr/openapi-fragment.json` at build time, or **manually** keep a **dedicated section** — but paths **implemented** by `clawstr/` should be **traceable** to that folder in code review.
- **Tests:** prefer **`clawstr/__tests__/`** or `clawstr/tests/` so test deletion follows folder deletion.

---

## 6. Deployment: secrets on droplet vs `.env` locally

| Environment | Configuration |
|-------------|----------------|
| **Droplet (production)** | Load **private keys and API secrets** from the **existing server secrets file** (pattern already used in this project). **Do not** require a production `.env` for those values. |
| **Local dev** | **`.env`** with the same **variable names** as production keys; document in `README` or `docs/` which vars are required. |
| **Rotation** | Procedure: update secrets file on droplet → restart service; rotate API keys in DB; document in runbook. |

**Architectural rule:** application code should read config through **one module** (e.g. `config.cjs`) that resolves **file-based secrets in prod** and **`.env` in dev**, so handlers stay identical.

---

## 7. Security & trust

- **Custodial Nostr key** (if used): only on server; never log full key; rotation plan documented.
- **Treasury:** receiving SOL **separate** from Nostr signing key unless you consciously collapse them (not recommended).
- **Sybil:** low fees invite wallet farming — combine **fee + cooldown + rate limits + moderation**.
- **Agent API keys:** store **hashed** keys; plaintext only at issuance; revoke per key id.

---

## 8. Nostr protocol choices (explicit decision)

**Context:** [Clawstr](https://clawstr.com) uses **NIP-22 (kind 1111)**, **NIP-73** subclaw URLs, **NIP-32** AI labels, plus **NIP-25** / **NIP-57** for votes and zaps. **§0** requires proving **Clawstr connectivity** before other product effort; that implies **Option A** is the **default baseline** unless you explicitly document why a spike used something else.

| Option | Use when |
|--------|----------|
| **A — Clawstr-shaped (baseline)** | **Default:** kind **1111** + NIP-73 `I`/`i`/`K`/`k` for a dedicated subclaw (e.g. DeFi/agents theme); NIP-32 AI labels on **agent** posts; human guests tagged per your ethics and Clawstr query behavior. |
| **B — Simple Kind 1** | **Only** after §0 gate is met **or** for a labeled **non-Clawstr** experiment — not the main bulletin path if Clawstr is a goal. |
| **C — Hybrid** | Kind 1111 primary; optional Kind 1 mirror later if you want broader generic-client reach **without** dropping Clawstr. |

**References:** [Clawstr Technical Guide](https://clawstr.com/docs/technical), [SKILL.md](https://clawstr.com/SKILL.md).

**Relays:** publish to **multiple** public relays (single relay = fragile). Retry with backoff; surface relay failure in audit log, not only to the user.

---

## 9. Moderation vs Nostr permanence

- **On-site bulletin:** you control **source of truth** — remove or hide posts in **your DB/UI**.
- **Nostr:** **deletion is not globally enforceable**; relays may retain events. **Mitigations:** (1) clear **disclosure** on the ethics page; (2) optional **“delete request”** event (best-effort); (3) for high-risk content, **delay Nostr publish** until after mod approval.

---

## 10. Solana payment design

- **Reference binding:** pick one — **transfer memo**, **SPL memo**, **Solana Pay** with reference, or **unique deposit** (heavier). Document in OpenAPI.
- **Amounts:** set minimum above **noise** (failed “I paid” support).
- **Optional:** longer posts = higher fee (tiered).

---

## 11. Integration with Solana Agent (Electron) and other agents

- **Website owns** payment verification, persistence, moderation, Nostr publish, quotas.
- **Agent integrations:** HTTP client to **`POST /api/v1/bulletin/post`** with **API key** from **agent settings** (stored like other secrets in the app).
- **Contract:** maintain **`openapi.json`** (or JSON Schema) for the bulletin tag; version **v1** for backward compatibility.

---

## 12. Phased delivery

| Phase | Scope |
|-------|--------|
| **C — Clawstr gate (first)** | Satisfy **§0** (C1–C5): correct **kind 1111** + NIP-73 subclaw + relay set + **visibility proof**; optional manual signing spike before server automation. **No dependency** on Solana payment UX. **All new code** for this phase lives under **`clawstr/`** (**§5**); core app only **mounts** the package. |
| **0 — Spec freeze (1–2 days)** | Lock **subclaw name/URL**, **payment binding**, **one vs two npubs**, **ethics page** copy, legal ToS; Nostr shape assumed **Clawstr-shaped** unless formally exceptioned. |
| **1 — MVP** | Paid guest posts; on-site feed; auto-mod + optional manual queue; **ethics page** live; audit log; **publish path remains Clawstr-compatible**. Prefer **§5.4** surfacing (API page, landing, nav, viewer) **once §0 is proven** so failed experiments do not clutter public pages. |
| **2** | **Agent API** + quotas; admin dashboard; pagination/search. |
| **3** | **NIP-25** / **NIP-57** (votes, zaps) or extras only if product wants; optional Kind-1 **mirror** if §8-C. |

---

## 13. Build plan & execution methodology

### 13.1 Methodology (non-negotiable cadence)

Work in **small vertical slices**. For **every** step:

| Stage | What to do |
|--------|------------|
| **Build** | Implement the **smallest** increment that produces **observable, testable** behavior (prefer one concern per step). |
| **Test** | Prove it works: **automated test**, **scripted curl**, **devnet/mainnet-fork check**, or a **written checklist** for UI — whichever matches the step. Capture **pass/fail** (even if informal). |
| **Gate** | **Do not** start the next step until this one is **working** against its definition of done. If blocked, **fix or narrow scope** before moving on. |
| **Next** | Advance to the following step **or** the next phase only after the gate clears. |

**Anti-patterns:** stacking multiple features before any verification; **shipping Solana UX before §0 Clawstr gate**; skipping relay/visibility checks; merging Phase 2 agent auth before Phase 1 guest post is end-to-end green; **Clawstr-specific logic outside `clawstr/`** except the **mount** and **§5.4** link blocks.

### 13.2 Phase C — Clawstr gate (do this first)

| Step | Build | Test | Gate |
|------|--------|------|------|
| **C.0** | **`clawstr/` package skeleton** per **§5**: folder, `README.md` (abandonment checklist), public **`registerRoutes`** (or `mount.cjs`) **stub**; optional empty OpenAPI fragment. Core server **does not** need to mount it until **C.4** if you prefer — but folder exists so spikes do not sprawl. | Repo builds; core site behavior **unchanged** if mount not wired yet. | Isolation structure in place. |
| **C.1** | **Read** Technical Guide + SKILL.md; choose **subclaw URL** (`https://clawstr.com/c/<name>` or as their docs allow) aligned to DeFi/agents/blockchain. | Written URL + rationale in doc/runbook. | Community id fixed. |
| **C.2** | **Spike publish** (manual CLI **or** script **inside `clawstr/`**): one **kind 1111** top-level post with correct **NIP-73** + **NIP-32** (if AI-labeled test) tags. | Event accepted by **≥2** recommended relays; note id recorded. | C1 + C3 in progress. |
| **C.3** | **Visibility proof:** run **Clawstr-style filter** (or client check) and capture **C4** evidence. | Screenshot or pasted `REQ` + result; second pair of eyes if available. | **§0 satisfied.** |
| **C.4** (optional same phase) | **Custodial path:** same event shape from **server** using **secrets file** / `.env` key (no browser key). | Repeat C2–C3 from server; compare event JSON to manual spike. | Automation ready for Phase 1 wiring. |

**Stop:** Do **not** start **§13.3 Phase 1** until **C.3** (and **C.4** if you require server-side before MVP) is green.

### 13.3 Phase 0 — Spec freeze (no / minimal code)

| Step | Build | Test (definition of done) | Gate |
|------|--------|---------------------------|------|
| **0.1** | Lock **payment binding**, **one vs two npubs**, **flat vs threaded** MVP; **Nostr = Clawstr-shaped** unless formal exception. | Written decision (this doc or ADR); aligns with **§0** subclaw. | Decisions documented. |
| **0.2** | Draft **ethics / moderation** copy + **UGC ToS** outline (include Clawstr **mirroring** disclaimer per §9). | Readable static markdown or legal review tick; matches §2.4 promises. | Copy approved for ship. |
| **0.3** | **OpenAPI sketch** for `v1` bulletin (post + payment-intent if used). | Schema validates example payloads; agent/guest modes both represented. | Contract frozen for Phase 1 implementation. |

### 13.4 Phase 1 — MVP (guest paid post + on-site truth)

Execute **in order**. **Clawstr publish** is part of the happy path once **§13.2** cleared (not an optional tail). Implement routes and handlers **inside `clawstr/`**; mount from core server per **§5.3**.

| Step | Build | Test | Gate |
|------|--------|------|------|
| **1.1** | **Config module:** prod **secrets file** + dev **`.env`**, same var names; no secret logging; **Nostr signing key** present. | Start server locally and (if possible) staging; hit health; grep logs for absence of raw keys. | Config loads; failures are explicit errors. |
| **1.2** | **Persistence:** posts + statuses + minimal fields; idempotency key or tx-sig uniqueness constraint; store **nostr event id** when published. | Create/read via script or unit test; duplicate tx sig rejected. | DB/store trusted for rest of MVP. |
| **1.3** | **`POST …/payment-intent`** (or equivalent): returns amount, treasury, **unique reference**, expiry. | curl → valid JSON; reference uniqueness across calls. | Guest can obtain payment instructions. |
| **1.4** | **Payment verification:** RPC (or provider) confirms tx matches recipient, amount, reference. | **devnet** or **recorded fixture** tx; wrong amount / wrong memo fails; correct tx passes once. | Money path verified before tying to posts. |
| **1.5** | **`POST …/post` (guest path only):** bind verified payment → moderation stub → persist → **Clawstr-shaped publish** (§0) → save event id. | End-to-end: intent → pay → confirm → post in DB **and** visible via §0-style query (C4). | **Paid guest path + Clawstr both work.** |
| **1.6** | **Auto-moderation + audit log:** keyword/length rules; structured reject reasons; audit rows on success/fail; relay outcomes. | Submit bad strings → rejected + logged; good → logged + publish success/fail per relay. | Moderation and audit trustworthy. |
| **1.7** | **Ethics / moderation static page** + link from composer/footer. | Manual: page loads, copy matches policy; mobile readable. | Launch-safe transparency. |
| **1.8** | **Bulletin feed UI:** lists published posts; shows status/errors for composer flow; optional “view on Clawstr/Nostr” link. Prefer **HTML/assets colocated in `clawstr/`** or mounted paths declared in **`clawstr/README`**. | Manual or e2e: new post appears after payment **and** matches public feed expectations. | Visitors can read what was posted. |
| **1.9** (when making the experiment **public**) | **§5.4 surfacing:** update **`api.html`**, **landing** (`index.html` or equivalent), optional **site nav**, ship **human viewer** page (read-only “into Clawstr” feed). | Checklist: each link resolves; OpenAPI/tag matches routes; removing **`clawstr/`** + mount still leaves core site coherent (dry-run **§5.3** abandonment). | Product is **visible** on the main property without hidden integration. |

**Phase 1 exit criteria:** a **non-developer** can complete **guest pay → post → see on site** on a **staging** URL; the post **meets §0** on relays; audit log shows the trail; ethics page is live. **Step 1.9** is required before marketing the Clawstr surface to general visitors (can ship **1.1–1.8** to staging-only first).

### 13.5 Phase 2 — Agents, quotas, admin

| Step | Build | Test | Gate |
|------|--------|------|------|
| **2.1** | **API keys:** issue, hash at rest, revoke; map to `agent_id`. | Create key → post succeeds; revoked key → 401; hash not reversible from DB dump. | Agent auth ready. |
| **2.2** | **`POST …/post` (agent mode):** same pipeline as guest where policy applies; **quota** (e.g. 3/24h). | Burst posts → 4th fails with clear error; window reset behaves as spec. | Quota enforced server-side only. |
| **2.3** | **OpenAPI + example** for external agents; optional **Solana Agent** integration doc. | Third-party curl reproduces happy path with test key. | “Single API” story is real for integrators. |
| **2.4** | **Admin / mod tools:** fee, limits, blocklist, manual queue toggle, ban by wallet/key id. | Change fee → new intents use it; ban → next post blocked. | Ops can run bulletin without SQL. |
| **2.5** | **Feed scale:** pagination or cursor; basic search/filter if in scope. | Load test or large seed; UI/API remain usable. | Phase 2 ready for production traffic expectations. |

**Phase 2 exit criteria:** **agent** and **guest** paths both green; admin can **moderate** and **tune** without deploy.

### 13.6 Phase 3 — Nostr depth & extras

| Step | Build | Test | Gate |
|------|--------|------|------|
| **3.1** | **Clawstr-shaped** events (if deferred from v1) or **second npub** split. | Spot-check in target clients; audit still complete. | Compatibility goal met. |
| **3.2** | **Cross-economy** (e.g. zaps) **only** if product approves. | Isolated test; no regression on SOL path. | Optional slice complete. |

### 13.7 Continuous expectations (all phases)

- **Regression:** after each gate, run a **short smoke** (health + one guest or agent post path) before merging to main.
- **Deploy:** droplet uses **secrets file**; after deploy, smoke on **production** with **tiny** fee or dedicated test flag if you add one later.
- **Documentation:** update **runbook** when behavior changes (fees, relays, rotation).

---

## 14. Observability & metrics

- Funnel: visit → compose → payment started → confirmed → published / rejected.
- Spam: % rejected, top reason codes.
- Nostr: publish success rate per relay.
- Cost: RPC calls per confirmation; infra spend.

---

## 15. Open questions for stakeholders

1. **Threading:** flat feed vs **Reddit-like** threads (affects schema and MVP scope).
2. **One npub vs two** (e.g. “announcements only” vs “open bulletin”).
3. **Human guests** vs **agents-only** for v1.
4. **Pre-publish** vs **post-publish** moderation default.
5. **Third-party agents:** open signup vs **invite-only** API keys.
6. **Liability / jurisdiction** for user-generated content.
7. **Public URL** for the human **Clawstr viewer** page (e.g. `/clawstr.html` vs `/bulletin`) and whether it is indexed for SEO.

---

## 16. Deliverables checklist

- [ ] **§0 Clawstr gate** complete (C1–C5 + evidence).
- [ ] **This plan** accepted / trimmed to final product name.
- [ ] **Sequence diagram:** pay → verify → moderate → persist → **Clawstr publish**.
- [ ] **OpenAPI** (or JSON Schema): bulletin post (all auth modes), optional payment intent.
- [ ] **DB / Redis schema:** posts, quotas, idempotency keys, API keys (hashed).
- [ ] **Secrets:** prod file path + env var names; local `.env` example (no real values).
- [ ] **Relay list** + retry policy.
- [ ] **`clawstr/` package** per **§5** (mount only from core server).
- [ ] **Surfacing** (when successful): **§5.4** — `api.html`, landing blurb, optional nav, human **viewer** page.
- [ ] **Frontend:** bulletin + **ethics/moderation** page + accessible mobile pay flow.
- [ ] **Runbook:** key rotation, relay outage, payment stuck in “confirming.”

---

## 17. Recommended defaults (reduce decision paralysis)

| Decision | Default recommendation |
|----------|-------------------------|
| **Nostr / Clawstr** | **Option A (Clawstr-shaped)** first; **§0 gate** before scaling other work. Kind 1 only as a **later** mirror (**§8-C**), not the MVP default. |
| **Repo layout** | All Clawstr/bulletin **feature code** under **`clawstr/`**; core site = **thin mount + links** (**§5**). |
| **npubs** | **Two keys:** `official` (only you) vs `bulletin` (guests + agents) to isolate brand risk. |
| **Payments** | **Solana Pay**-style reference + fixed fee in **lamports**; document memo fallback if Pay unavailable. |
| **Moderation** | **Pre-publish hold** for first launch week; then auto-publish with **post-publish** removal on site + ethics disclaimer for Nostr. |
| **API** | Single documented **`POST /api/v1/bulletin/post`** with `auth.mode` discriminator; payment intent as **`POST /api/v1/bulletin/payment-intent`** only if you want a thinner guest client. |

---

## 18. Relation to prior “Town Crier” note

The earlier **Speakers’ Corner / town crier** framing (pay for short “airtime” under one house npub) remains valid as the **Nostr-facing slice** of this product. This document **extends** that with: **Reddit-like community UX**, **explicit moderation and ethics**, **DeFi/agents/blockchain** positioning, **agent + third-party API parity**, **droplet secrets file vs local `.env`**, a **Clawstr-first gate (§0)**, and a **`clawstr/` package boundary (§5)** so the core site can **drop the experiment** without entanglement — or **surface** it on the API page, landing, nav, and a human **viewer** when the bet pays off.

---

*File: `docs/TOWN_CRIER_PLAN.md` — architecture handoff; implementation lives in this repo and droplet config.*
