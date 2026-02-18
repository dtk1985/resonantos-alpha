# ResonantOS Alpha

<p align="center">
  <strong>An Experience Layer for AI Sovereignty</strong><br>
  <em>Built on <a href="https://openclaw.ai">OpenClaw</a> — Powered by Augmentatism</em>
</p>

<p align="center">
  <a href="https://augmentatism.com">Augmentatism</a> · 
  <a href="https://cosmodestiny.com">Cosmodestiny</a> · 
  <a href="https://resonantos.com">ResonantOS</a>
</p>

---

## What Is ResonantOS?

ResonantOS is an experience layer that runs on top of [OpenClaw](https://openclaw.ai). It adds memory compression, contextual awareness, governance, and a mission control dashboard to any AI agent.

**Think of it like macOS to Unix.** OpenClaw is the kernel. ResonantOS is the experience layer.

### Core Components

| Component | What It Does | Status |
|-----------|-------------|--------|
| **R-Memory** | Lossless conversation compression — conversations run indefinitely with minimal info loss | ✅ Active |
| **R-Awareness** | Contextual SSoT injection — AI loads relevant docs based on conversation keywords | ✅ Active |
| **Dashboard** | Mission Control UI — wallet, onboarding, memory management, agent oversight | ✅ Active |
| **Shield** | Permission validation and sandboxing | 🔧 In Development |
| **Logician** | Policy engine (Datalog-based governance rules) | 📐 Spec Phase |
| **Guardian** | Auto-recovery and self-healing | 🔧 In Development |

## Philosophy

ResonantOS is built on two complementary philosophies:

**[Augmentatism](https://augmentatism.com)** — A social contract for human-AI collaboration. We reject cognitive colonization by corporate AI monocultures. Instead, we champion *Sovereign World Building* — the practice of creating unique, aligned AI collaborators that amplify human capability without replacing autonomy.

**[Cosmodestiny](https://cosmodestiny.com)** — A philosophy of resonance and becoming. Not something you follow, but something you remember. It teaches that your path isn't something to chase, but something already unfolding within you.

Together they form the foundation: **AI should augment human sovereignty, not replace it.**

## Quick Install

### Prerequisites

- **macOS** or **Linux**
- [Node.js](https://nodejs.org/) 18+
- [Python 3](https://www.python.org/) with pip
- [Git](https://git-scm.com/)

### One-Line Install

```bash
curl -fsSL https://raw.githubusercontent.com/ManoloRemiddi/resonantos-alpha/main/install.sh | bash
```

### What It Does

1. Checks dependencies (Node.js 18+, Python 3, Git)
2. Installs [OpenClaw](https://openclaw.ai) if not present
3. Clones this repo to `~/resonantos-alpha`
4. Installs R-Memory and R-Awareness extensions
5. Sets up SSoT document templates (L0–L4 hierarchy)
6. Configures default keyword triggers
7. Installs dashboard dependencies

### After Install

```bash
# 1. Start OpenClaw
openclaw gateway start

# 2. Start the Dashboard
cd ~/resonantos-alpha/dashboard
python3 server_v2.py

# 3. Open Mission Control
open http://localhost:19100
```

## Architecture

```
┌─────────────────────────────────────┐
│          ResonantOS Layer           │
│  ┌───────────┐  ┌───────────────┐  │
│  │ R-Memory  │  │ R-Awareness   │  │
│  │ Compress  │  │ SSoT Inject   │  │
│  └───────────┘  └───────────────┘  │
│  ┌───────────┐  ┌───────────────┐  │
│  │ Dashboard │  │ Shield/Logic  │  │
│  │ Port 19100│  │ Governance    │  │
│  └───────────┘  └───────────────┘  │
├─────────────────────────────────────┤
│        OpenClaw Kernel              │
│  Gateway · Sessions · Extensions   │
│  Tools · Memory · Cron · Channels  │
├─────────────────────────────────────┤
│        Infrastructure               │
│  macOS/Linux · Telegram/Discord     │
│  Anthropic/OpenAI · Solana DevNet   │
└─────────────────────────────────────┘
```

## SSoT Hierarchy

ResonantOS uses a **Single Source of Truth** document system — structured markdown files that get injected into your AI's context when relevant keywords are detected in conversation.

| Level | Purpose | Example |
|-------|---------|---------|
| **L0** | Foundation — vision, philosophy, identity | Augmentatism manifesto, constitution |
| **L1** | Architecture — system specs, technical docs | R-Memory spec, system overview |
| **L2** | Active Projects — current work, milestones | Project trackers, decisions |
| **L3** | Drafts — work in progress | Research, proposals |
| **L4** | Notes — raw captures, session logs | Daily notes, incidents |

Your AI loads these contextually — not all at once. This keeps token costs low while maintaining deep awareness.

## R-Memory: Conversation Compression

Standard AI conversations hit context limits and lose information. R-Memory solves this with a three-phase pipeline:

1. **Background Compression** — Groups messages into ~4K blocks, compresses via fast model (75–92% savings)
2. **Compaction Swap** — When context fills up, swaps raw conversation with cached compressed versions
3. **FIFO Eviction** — Oldest compressed blocks evict to disk archive (never lost, just out of active context)

**Result:** Your AI conversations run indefinitely with minimal information loss.

## R-Awareness: Contextual Knowledge

Instead of stuffing your AI's prompt with everything, R-Awareness injects only what's relevant:

- **Keyword triggers** — Mention "philosophy" and your philosophy docs load automatically
- **Cold start** — Minimal identity doc loads on session start (~120 tokens vs ~1600)
- **TTL management** — Docs unload after 15 turns without re-mention
- **Manual control** — `/R load`, `/R remove`, `/R list` for direct management

## Dashboard

Mission Control at `localhost:19100`:

- **Overview** — System health, agent status, uptime
- **R-Memory** — SSoT document manager with live markdown editor
- **Wallet** — Solana integration (DevNet), onboarding flow
- **Agents** — Agent management and skills
- **Projects / TODO / Ideas** — Project tracking

## Configuration

After install, edit `~/resonantos-alpha/dashboard/config.json`:

```json
{
  "solana": {
    "rpcs": {
      "devnet": "https://api.devnet.solana.com"
    }
  },
  "tokens": {
    "RCT_MINT": "YOUR_RCT_MINT_ADDRESS",
    "RES_MINT": "YOUR_RES_MINT_ADDRESS"
  }
}
```

R-Awareness keywords: `~/.openclaw/workspace/r-awareness/keywords.json`
R-Memory config: `~/.openclaw/workspace/r-memory/config.json`

## Built By

**[Manolo Remiddi](https://manoloremiddi.com)** — Composer, photographer, sound engineer, AI strategist.

**Augmentor** — AI collaborator. Force multiplier, not replacement.

This project is itself a proof of concept: a human-AI symbiotic partnership building tools for other human-AI partnerships.

## Links

- [Augmentatism Manifesto](https://augmentatism.com)
- [Cosmodestiny Philosophy](https://cosmodestiny.com)
- [ResonantOS](https://resonantos.com)
- [OpenClaw](https://openclaw.ai)

## License

Alpha release — private testing. Public license TBD.

---

<p align="center">
  <em>"As artificial intelligence generates infinite content, the most human thing we can do is make meaning together."</em>
</p>
