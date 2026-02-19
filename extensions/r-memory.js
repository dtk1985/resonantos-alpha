/**
 * R-Memory V4.6.2 — High-Fidelity Compression Extension for OpenClaw
 * @version 4.6.2
 * @date 2026-02-15
 *
 * Changes from V4.6.1:
 * - Fixed: background compression now caches ALL blocks (was skipping last block = most turns never cached)
 * - Added: hash comparison logging between agent_end and compaction paths
 * - Added: cache miss diagnostics with text preview for debugging
 * - Result: cache hits at swap time, eliminating double Haiku calls
 *
 * V4.6.1 changes:
 * - Restored blockSize (default 4k tokens) from original spec
 * - Turns larger than blockSize are split at message boundaries
 * - Single messages larger than blockSize are hard-split
 * - No more "stuck with 1 giant turn" — everything becomes manageable blocks
 * - Turn-based grouping still happens first, then blocks are sized
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ============================================================================
// Dependencies from pi-ai
// ============================================================================
let completeSimple = null;
let getModel = null;
for (const p of [
  "@mariozechner/pi-ai",
  "/opt/homebrew/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai",
  "/usr/local/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai",
]) {
  try { completeSimple = require(p).completeSimple; break; } catch (e) {}
}
for (const p of [
  "@mariozechner/pi-ai",
  "/opt/homebrew/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai",
  "/usr/local/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai",
]) {
  try { getModel = require(p).getModel; break; } catch (e) {}
}

// ============================================================================
// Config
// ============================================================================
const DEFAULT_CONFIG = {
  evictTrigger: 80000,
  compressTrigger: 36000,
  blockSize: 4000,
  minCompressChars: 200,
  compressionModel: "anthropic/claude-haiku-4-5",
  maxParallelCompressions: 4,
  storageDir: "r-memory",
  archiveDir: "r-memory/archive",
  logFile: "r-memory/r-memory.log",
  enabled: true,
};

let config = { ...DEFAULT_CONFIG };
let workspaceDir = "";
let resolvedApiKey = null;
let currentSessionId = null;
let compactionHistory = [];
let messageCache = new Map();
let lastProcessedBlockCount = 0;
const MAX_CACHE_SIZE = 2000;
let compressionQueue = [];
let activeCompressions = 0;

// ============================================================================
// Utilities
// ============================================================================
function log(level, msg, data) {
  if (!workspaceDir) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  try { fs.appendFileSync(path.join(workspaceDir, config.logFile), line + "\n"); } catch (e) {}
}

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function hashText(text) { return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32); }
function estimateTokens(text) { return Math.ceil((text || "").length / 4); }

function buildModelObject(modelString) {
  const parts = (modelString || "anthropic/claude-haiku-4-5").split("/");
  const provider = parts[0] || "anthropic";
  const modelId = parts.slice(1).join("/") || "claude-haiku-4-5";
  if (getModel) {
    try { const m = getModel(provider, modelId); log("DEBUG", "Model resolved via getModel", { id: m.id, provider: m.provider }); return m; }
    catch (e) { log("WARN", "getModel failed", { error: e.message }); }
  }
  return { provider, id: modelId, contextWindow: 200000, inputModalities: ["text"] };
}

// ============================================================================
// Config loading
// ============================================================================
function loadConfig() {
  try {
    const p = path.join(workspaceDir, config.storageDir, "config.json");
    if (fs.existsSync(p)) {
      const userConfig = JSON.parse(fs.readFileSync(p, "utf-8"));
      const cleaned = {};
      for (const [key, val] of Object.entries(userConfig)) {
        if (!key.startsWith("//")) cleaned[key] = val;
      }
      config = { ...DEFAULT_CONFIG, ...cleaned };
    } else {
      ensureDir(path.join(workspaceDir, config.storageDir));
      fs.writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
    }
    log("INFO", "Config loaded", { compressTrigger: config.compressTrigger, evictTrigger: config.evictTrigger, blockSize: config.blockSize });
  } catch (e) { log("ERROR", "Config load failed", { error: e.message }); }
}

// ============================================================================
// Message text extraction
// ============================================================================
function extractMessageText(msg) {
  const parts = [];
  switch (msg.role) {
    case "user": {
      parts.push("[Human]:");
      if (typeof msg.content === "string") { parts.push(msg.content); }
      else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text" && b.text) parts.push(b.text);
          if (b.type === "image") parts.push("[Image: ~1200 tokens]");
        }
      }
      break;
    }
    case "assistant": {
      parts.push("[AI]:");
      if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text") parts.push(b.text);
          else if (b.type === "thinking") {
            const t = b.thinking || "";
            if (t.length > 2000) { parts.push(`[Thinking]: ${t.slice(0, 500)}\n...[truncated]...\n${t.slice(-500)}`); }
            else { parts.push(`[Thinking]: ${t}`); }
          }
          else if (b.type === "toolCall") {
            parts.push(`[Tool: ${b.name}]`);
            try { parts.push(`<PRESERVE_VERBATIM>\n${JSON.stringify(b.arguments, null, 2)}\n</PRESERVE_VERBATIM>`); }
            catch (e) { parts.push("[args]"); }
          }
        }
      }
      break;
    }
    case "toolResult": {
      parts.push("[Tool Result]:");
      if (typeof msg.content === "string") {
        const c = msg.content;
        parts.push(c.length > 8000 ? c.slice(0, 4000) + "\n...[truncated]...\n" + c.slice(-2000) : c);
      } else if (Array.isArray(msg.content)) {
        for (const b of msg.content) {
          if (b.type === "text" && b.text) { const t = b.text; parts.push(t.length > 8000 ? t.slice(0, 4000) + "\n...[truncated]...\n" + t.slice(-2000) : t); }
          if (b.type === "image") parts.push("[Image: ~1200 tokens]");
        }
      }
      break;
    }
    case "bashExecution": {
      parts.push("[Bash]:");
      parts.push(`$ ${msg.command || ""}`);
      const out = msg.output || "";
      parts.push(out.length > 8000 ? out.slice(0, 4000) + "\n...[truncated]...\n" + out.slice(-2000) : out);
      break;
    }
    case "compactionSummary": { parts.push("[Previous Compressed]:"); parts.push(msg.summary || ""); break; }
    case "branchSummary": { parts.push("[Branch Context]:"); parts.push(msg.summary || ""); break; }
    case "custom": { parts.push("[Custom]:"); if (typeof msg.content === "string") parts.push(msg.content); break; }
    default: { parts.push(`[${msg.role || "unknown"}]:`); if (typeof msg.content === "string") parts.push(msg.content); break; }
  }
  return parts.join("\n");
}

// ============================================================================
// Block creation helpers
// ============================================================================

/**
 * Create a finalized block from messages.
 */
function finalizeBlock(messages) {
  const textParts = messages.map(m => extractMessageText(m));
  const text = textParts.join("\n\n");
  return { messages, text, hash: hashText(text), tokens: estimateTokens(text) };
}

/**
 * Create a finalized block from entry objects [{index, id, message}].
 */
function finalizeEntryBlock(entries) {
  const textParts = entries.map(e => extractMessageText(e.message));
  const text = textParts.join("\n\n");
  return {
    entries,
    firstEntryId: entries[0].id,
    firstEntryIndex: entries[0].index,
    text,
    hash: hashText(text),
    tokens: estimateTokens(text),
  };
}

/**
 * Hard-split a single long text into chunks of ~blockSize tokens.
 * Used when a single message exceeds blockSize.
 */
function hardSplitText(text, maxChars) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxChars) {
    // Try to split at a newline near the boundary
    let splitAt = maxChars;
    const newlinePos = remaining.lastIndexOf("\n", maxChars);
    if (newlinePos > maxChars * 0.7) splitAt = newlinePos + 1;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

// ============================================================================
// Block grouping from flat messages (for background compression)
//
// Step 1: Group into turns (human prompt + all AI replies)
// Step 2: Split any turn > blockSize at message boundaries
// Step 3: Hard-split any single message > blockSize
// ============================================================================

function groupMessagesIntoBlocks(messages) {
  // Step 1: Group into turns
  const turns = [];
  let currentMsgs = [];
  for (const msg of messages) {
    if (msg.role === "compactionSummary" || msg.role === "branchSummary") continue;
    if (msg.role === "user" && currentMsgs.length > 0) {
      turns.push(currentMsgs);
      currentMsgs = [msg];
    } else {
      currentMsgs.push(msg);
    }
  }
  if (currentMsgs.length > 0) turns.push(currentMsgs);

  // Step 2 & 3: Split oversized turns into blocks
  const blocks = [];
  const maxTokens = config.blockSize || 4000;
  const maxChars = maxTokens * 4;

  for (const turnMsgs of turns) {
    const turnText = turnMsgs.map(m => extractMessageText(m)).join("\n\n");
    const turnTokens = estimateTokens(turnText);

    if (turnTokens <= maxTokens) {
      // Small turn — single block
      blocks.push(finalizeBlock(turnMsgs));
      continue;
    }

    // Oversized turn — split at message boundaries
    let blockMsgs = [];
    let blockTokens = 0;

    for (const msg of turnMsgs) {
      const msgText = extractMessageText(msg);
      const msgTokens = estimateTokens(msgText);

      if (msgTokens > maxTokens) {
        // Finalize current block if any
        if (blockMsgs.length > 0) {
          blocks.push(finalizeBlock(blockMsgs));
          blockMsgs = [];
          blockTokens = 0;
        }
        // Hard-split this single large message
        const chunks = hardSplitText(msgText, maxChars);
        for (const chunk of chunks) {
          const syntheticMsg = { ...msg, _chunkText: chunk };
          blocks.push({
            messages: [syntheticMsg],
            text: chunk,
            hash: hashText(chunk),
            tokens: estimateTokens(chunk),
          });
        }
        continue;
      }

      if (blockTokens + msgTokens > maxTokens && blockMsgs.length > 0) {
        // Current block would exceed limit — finalize and start new
        blocks.push(finalizeBlock(blockMsgs));
        blockMsgs = [msg];
        blockTokens = msgTokens;
      } else {
        blockMsgs.push(msg);
        blockTokens += msgTokens;
      }
    }
    // Finalize remaining
    if (blockMsgs.length > 0) {
      blocks.push(finalizeBlock(blockMsgs));
    }
  }
  return blocks;
}

// ============================================================================
// Block grouping from branchEntries (for compaction handler)
// Same logic but preserves entry IDs for firstKeptEntryId
// ============================================================================

function groupEntriesIntoBlocks(branchEntries, startIndex) {
  // Step 1: Group into turns
  const turns = [];
  let currentEntries = [];

  for (let i = startIndex; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    const msg = getMessageFromEntry(entry);
    if (!msg) continue;
    if (msg.role === "compactionSummary" || msg.role === "branchSummary") continue;

    if (msg.role === "user" && currentEntries.length > 0) {
      turns.push(currentEntries);
      currentEntries = [{ index: i, id: entry.id, message: msg }];
    } else {
      currentEntries.push({ index: i, id: entry.id, message: msg });
    }
  }
  if (currentEntries.length > 0) turns.push(currentEntries);

  // Step 2 & 3: Split oversized turns into blocks
  const blocks = [];
  const maxTokens = config.blockSize || 4000;
  const maxChars = maxTokens * 4;

  for (const turnEntries of turns) {
    const turnText = turnEntries.map(e => extractMessageText(e.message)).join("\n\n");
    const turnTokens = estimateTokens(turnText);

    if (turnTokens <= maxTokens) {
      blocks.push(finalizeEntryBlock(turnEntries));
      continue;
    }

    // Oversized turn — split at message boundaries
    let blockEntries = [];
    let blockTokens = 0;

    for (const entry of turnEntries) {
      const msgText = extractMessageText(entry.message);
      const msgTokens = estimateTokens(msgText);

      if (msgTokens > maxTokens) {
        if (blockEntries.length > 0) {
          blocks.push(finalizeEntryBlock(blockEntries));
          blockEntries = [];
          blockTokens = 0;
        }
        // Hard-split single large message — each chunk keeps the entry's ID
        const chunks = hardSplitText(msgText, maxChars);
        for (let c = 0; c < chunks.length; c++) {
          blocks.push({
            entries: [entry],
            firstEntryId: entry.id,
            firstEntryIndex: entry.index,
            text: chunks[c],
            hash: hashText(chunks[c]),
            tokens: estimateTokens(chunks[c]),
          });
        }
        continue;
      }

      if (blockTokens + msgTokens > maxTokens && blockEntries.length > 0) {
        blocks.push(finalizeEntryBlock(blockEntries));
        blockEntries = [entry];
        blockTokens = msgTokens;
      } else {
        blockEntries.push(entry);
        blockTokens += msgTokens;
      }
    }
    if (blockEntries.length > 0) {
      blocks.push(finalizeEntryBlock(blockEntries));
    }
  }
  return blocks;
}

/**
 * Extract message from a branchEntry (mirrors OpenClaw's getMessageFromEntry)
 */
function getMessageFromEntry(entry) {
  if (entry.type === "message" && entry.message) return entry.message;
  if (entry.type === "custom") log("DEBUG", "Custom entry structure", { keys: Object.keys(entry), customType: entry.customType, dataType: typeof entry.data, dataPreview: JSON.stringify(entry.data).slice(0, 200) });
  if (entry.type === "custom" && entry.data) return { role: "assistant", content: typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data) };
  if (entry.type === "custom_message") return { role: "custom", content: entry.content || "" };
  if (entry.type === "compaction") return { role: "compactionSummary", summary: entry.summary || "" };
  if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary || "" };
  return null;
}

// ============================================================================
// API key resolution (provider-aware)
// ============================================================================
function resolveApiKeyForProvider(provider) {
  if (!provider) provider = "anthropic";
  // 1. Check env vars per provider
  const envMap = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", google: "GOOGLE_API_KEY" };
  if (envMap[provider] && process.env[envMap[provider]]) {
    log("INFO", `API key from env (${provider})`); return process.env[envMap[provider]];
  }
  try {
    // 2. Check auth-profiles.json — match by provider name in profile key
    const agentAuth = path.join(process.env.HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    if (fs.existsSync(agentAuth)) {
      const data = JSON.parse(fs.readFileSync(agentAuth, "utf-8"));
      if (data.profiles) {
        for (const [key, profile] of Object.entries(data.profiles)) {
          if (key.includes(provider) && profile?.token) {
            log("INFO", `API key from auth-profiles (${key})`); return profile.token;
          }
        }
      }
    }
    // 3. Check credentials directory
    const credDir = path.join(process.env.HOME, ".openclaw", "credentials");
    if (fs.existsSync(credDir)) {
      for (const f of fs.readdirSync(credDir)) {
        if (f.includes(provider) && f.endsWith(".json")) {
          const data = JSON.parse(fs.readFileSync(path.join(credDir, f), "utf-8"));
          if (data.token) { log("INFO", `API key from ${f}`); return data.token; }
        }
      }
    }
  } catch (e) { log("WARN", "Credential scan failed", { error: e.message }); }
  log("WARN", `No API key found for provider: ${provider}`);
  return null;
}

// Discover available providers from auth-profiles
function discoverProviders() {
  const providers = [];
  try {
    const agentAuth = path.join(process.env.HOME, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
    if (fs.existsSync(agentAuth)) {
      const data = JSON.parse(fs.readFileSync(agentAuth, "utf-8"));
      if (data.profiles) {
        for (const [key, profile] of Object.entries(data.profiles)) {
          if (profile?.token) {
            const prov = profile.provider || key.split(":")[0] || "unknown";
            providers.push({ key, provider: prov });
          }
        }
      }
    }
  } catch (e) { log("WARN", "Provider discovery failed", { error: e.message }); }
  return providers;
}

// Auto-select cheapest compression model from available providers
const CHEAP_MODELS = {
  anthropic: "anthropic/claude-haiku-4-5",
  openai: "openai/gpt-4o-mini",
  google: "google/gemini-2.0-flash",
};

function autoSelectCompressionModel() {
  const providers = discoverProviders();
  if (providers.length === 0) return null;
  // Prefer cheapest: haiku > gpt-4o-mini > gemini-flash
  for (const pref of ["anthropic", "openai", "google"]) {
    if (providers.some(p => p.provider === pref) && CHEAP_MODELS[pref]) {
      log("INFO", `Auto-selected compression model: ${CHEAP_MODELS[pref]}`);
      return CHEAP_MODELS[pref];
    }
  }
  // Fallback: first available provider
  const first = providers[0].provider;
  if (CHEAP_MODELS[first]) return CHEAP_MODELS[first];
  return null;
}

// Legacy wrapper
function resolveApiKey() {
  const model = buildModelObject(config.compressionModel);
  return resolveApiKeyForProvider(model.provider);
}

// ============================================================================
// Archive & cache
// ============================================================================
function archiveRawBlock(hash, rawText) {
  const dir = path.join(workspaceDir, config.archiveDir);
  ensureDir(dir);
  const filepath = path.join(dir, `${hash}.md`);
  if (!fs.existsSync(filepath)) { fs.writeFileSync(filepath, rawText); }
}

function getHistoryPath(sessionId) { return path.join(workspaceDir, config.storageDir, `history-${sessionId || "default"}.json`); }
function loadCompactionHistory(sessionId) {
  try {
    const p = getHistoryPath(sessionId);
    if (fs.existsSync(p)) { compactionHistory = JSON.parse(fs.readFileSync(p, "utf-8")); log("INFO", "History loaded", { session: sessionId, entries: compactionHistory.length }); }
    else { compactionHistory = []; }
  } catch (e) { compactionHistory = []; }
}
function saveCompactionHistory() {
  try { fs.writeFileSync(getHistoryPath(currentSessionId), JSON.stringify(compactionHistory, null, 2)); }
  catch (e) { log("ERROR", "History save failed", { error: e.message }); }
}
function detectSessionId(branchEntries) {
  if (branchEntries?.length > 0) return branchEntries[0].id || "default";
  return "default";
}

function getCachePath() { return path.join(workspaceDir, config.storageDir, "block-cache.json"); }
function loadMessageCache() {
  try {
    const p = getCachePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      messageCache = new Map(Object.entries(data));
      log("INFO", "Block cache loaded", { entries: messageCache.size });
    }
    // Backward compat: try older cache files
    if (messageCache.size === 0) {
      for (const oldName of ["turn-cache.json", "message-cache.json"]) {
        const oldPath = path.join(workspaceDir, config.storageDir, oldName);
        if (fs.existsSync(oldPath)) {
          const data = JSON.parse(fs.readFileSync(oldPath, "utf-8"));
          messageCache = new Map(Object.entries(data));
          log("INFO", `Loaded legacy cache (${oldName})`, { entries: messageCache.size });
          break;
        }
      }
    }
  } catch (e) { log("WARN", "Cache load failed", { error: e.message }); messageCache = new Map(); }
}
function saveMessageCache() {
  try { fs.writeFileSync(getCachePath(), JSON.stringify(Object.fromEntries(messageCache))); }
  catch (e) { log("ERROR", "Cache save failed", { error: e.message }); }
}

function cleanupCache() {
  if (messageCache.size <= MAX_CACHE_SIZE) return;
  const entriesToRemove = messageCache.size - MAX_CACHE_SIZE;
  let removed = 0;
  for (const key of messageCache.keys()) {
    if (removed >= entriesToRemove) break;
    messageCache.delete(key);
    removed++;
  }
  log("INFO", "Cache cleanup", { removed, remaining: messageCache.size });
  saveMessageCache();
}

// ============================================================================
// Compression
// ============================================================================
async function compressSingleBlock(rawText) {
  if (!completeSimple || !resolvedApiKey) return null;
  const rawTokens = estimateTokens(rawText);
  if (rawText.length < config.minCompressChars) {
    return { compressed: rawText, tokensRaw: rawTokens, tokensCompressed: rawTokens };
  }
  const model = buildModelObject(config.compressionModel);
  try {
    const response = await completeSimple(model, {
      systemPrompt: `You are a high-fidelity conversation compressor.
RULES:
- Preserve ALL decisions, facts, parameters, code snippets, file paths, error messages
- Preserve temporal markers and speaker labels ([Human], [AI])
- Redact any API keys, tokens, or secrets — replace with [REDACTED]
- Use tables instead of prose where possible
- Remove filler, pleasantries, redundancy
- Preserve reasoning behind key decisions (WHY something was chosen, not just WHAT)
- Remove routine reasoning and intermediate steps that led to obvious conclusions
- Content inside <PRESERVE_VERBATIM> tags must be kept EXACTLY as-is
- This is compression, NOT summarization. Minimize information loss.
- Output must be significantly shorter than input`,
      messages: [{ role: "user", content: [{ type: "text", text: `Compress this conversation block:\n\n${rawText}` }], timestamp: Date.now() }],
    }, { maxTokens: Math.ceil(rawTokens * 0.8), apiKey: resolvedApiKey });
    if (response.stopReason === "error") { log("ERROR", "Haiku error", { error: response.errorMessage }); return null; }
    const compressed = response.content.filter(c => c.type === "text").map(c => c.text).join("\n");
    const compressedTokens = estimateTokens(compressed);
    if (compressedTokens >= rawTokens * 0.95) {
      return { compressed: rawText, tokensRaw: rawTokens, tokensCompressed: rawTokens };
    }
    const saving = ((1 - compressedTokens / rawTokens) * 100).toFixed(1);
    log("DEBUG", "Block compressed", { rawTokens, compressedTokens, saving: `${saving}%` });
    return { compressed, tokensRaw: rawTokens, tokensCompressed: compressedTokens };
  } catch (e) { log("ERROR", "Compression error", { error: e.message }); return null; }
}

// ============================================================================
// Background compression queue
// ============================================================================
function queueBlock(block) {
  if (!config.enabled || !completeSimple || !resolvedApiKey) return;
  if (messageCache.has(block.hash)) return;
  if (block.text.length < config.minCompressChars) {
    messageCache.set(block.hash, { compressed: block.text, tokensRaw: block.tokens, tokensCompressed: block.tokens });
    return;
  }
  compressionQueue.push({ text: block.text, hash: block.hash });
  processQueue();
}

function processQueue() {
  while (compressionQueue.length > 0 && activeCompressions < config.maxParallelCompressions) {
    const item = compressionQueue.shift();
    activeCompressions++;
    archiveRawBlock(item.hash, item.text);
    compressSingleBlock(item.text)
      .then(result => { if (result) { messageCache.set(item.hash, result); if (messageCache.size % 10 === 0) saveMessageCache(); } })
      .catch(e => log("ERROR", "Background compression failed", { hash: item.hash, error: e.message }))
      .finally(() => { activeCompressions--; processQueue(); });
  }
}

// ============================================================================
// FIFO eviction at 80k (compressed blocks only)
// ============================================================================
function applyFifoEviction() {
  const overheadPerBlock = 15;
  const baseOverhead = 20;
  let totalTokens = baseOverhead + compactionHistory.reduce((sum, e) => sum + e.tokensCompressed + overheadPerBlock, 0);
  let evicted = 0;
  while (totalTokens > config.evictTrigger && compactionHistory.length > 0) {
    const oldest = compactionHistory.shift();
    totalTokens -= (oldest.tokensCompressed + overheadPerBlock);
    evicted++;
    log("INFO", "FIFO evicted", { ts: oldest.timestamp, tokens: oldest.tokensCompressed });
  }
  if (evicted > 0) { log("INFO", "FIFO done", { evicted, remaining: compactionHistory.length, totalTokens }); }
}

// ============================================================================
// COMPACTION HANDLER
//
// Flow:
// 1. Compaction fires at 36k total context (OpenClaw trigger)
// 2. Group branchEntries into blocks (~4k each)
// 3. Calculate overflow (how much over 36k)
// 4. Swap oldest blocks: raw → pre-compressed (from cache)
// 5. Swap just enough to get back under 36k
// 6. Return compressed content + firstKeptEntryId to OpenClaw
// 7. OpenClaw handles reload via appendCompaction → buildSessionContext → replaceMessages
// ============================================================================
async function handleBeforeCompact(event) {
  if (!config.enabled) return undefined;
  const { preparation, branchEntries, signal } = event;

  if (!branchEntries || branchEntries.length === 0) {
    log("ERROR", "No branchEntries");
    return { cancel: true };
  }

  if (!completeSimple || !resolvedApiKey) {
    log("ERROR", "Cannot compress — CANCELLING to prevent lossy fallback");
    return { cancel: true };
  }

  // Session tracking
  const sessionId = detectSessionId(branchEntries);
  if (sessionId !== currentSessionId) {
    currentSessionId = sessionId;
    loadCompactionHistory(sessionId);
    log("INFO", "Session", { id: sessionId, history: compactionHistory.length });
  }

  // Find last compaction entry
  let prevCompactionIndex = -1;
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    if (branchEntries[i].type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  // Group all entries after last compaction into blocks
  const startIdx = prevCompactionIndex + 1;

  // === DIAGNOSTIC: Log all entry types so we can see what we're missing ===
  const typeCounts = {};
  const typeExamples = {};
  let totalEntryTokens = 0;
  for (let i = startIdx; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    const t = entry.type || "unknown";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    // Estimate tokens for this entry regardless of type
    const entryStr = JSON.stringify(entry).length;
    totalEntryTokens += Math.ceil(entryStr / 4);
    // Capture first example of each type (keys only, not full content)
    if (!typeExamples[t]) {
      typeExamples[t] = Object.keys(entry).slice(0, 10);
    }
  }
  const handled = typeCounts["message"] || 0;
  const total = branchEntries.length - startIdx;
  const missed = total - handled - (typeCounts["compaction"] || 0) - (typeCounts["branch_summary"] || 0);
  log("INFO", "=== DIAGNOSTIC: Entry types ===", {
    totalEntries: total,
    typeCounts,
    handledAsMessages: handled,
    potentiallyMissed: missed,
    totalEntryTokensEstimate: totalEntryTokens
  });
  log("INFO", "=== DIAGNOSTIC: Entry keys by type ===", typeExamples);
  // Also check what getMessageFromEntry returns for each type
  const nullTypes = {};
  for (let i = startIdx; i < branchEntries.length; i++) {
    const entry = branchEntries[i];
    const msg = getMessageFromEntry(entry);
    if (!msg) {
      const t = entry.type || "unknown";
      nullTypes[t] = (nullTypes[t] || 0) + 1;
    }
  }
  if (Object.keys(nullTypes).length > 0) {
    log("WARN", "=== DIAGNOSTIC: Entry types returning null ===", nullTypes);
  }
  // === END DIAGNOSTIC ===

  const blocks = groupEntriesIntoBlocks(branchEntries, startIdx);

  const tokensBefore = preparation?.tokensBefore || 0;
  log("INFO", "=== COMPACTION ===", {
    tokensBefore,
    blocks: blocks.length,
    blockSizes: blocks.map(b => b.tokens),
    blockHashes: blocks.map(b => b.hash.slice(0, 8)),
    prevCompaction: prevCompactionIndex >= 0,
    cacheSize: messageCache.size
  });

  if (blocks.length === 0) {
    log("INFO", "No blocks found — cancelling");
    return { cancel: true };
  }

  // Calculate overflow
  const overflow = tokensBefore - config.compressTrigger;
  if (overflow <= 0) {
    log("INFO", "Under trigger — cancelling", { tokensBefore, trigger: config.compressTrigger });
    return { cancel: true };
  }

  // Walk from oldest block, swap until savings >= overflow
  let totalSaved = 0;
  let blocksToSwap = 0;

  for (let i = 0; i < blocks.length; i++) {
    if (totalSaved >= overflow) break;
    const block = blocks[i];
    const cached = messageCache.get(block.hash);
    const compressedTokens = cached ? cached.tokensCompressed : Math.ceil(block.tokens * 0.6);
    const savings = block.tokens - compressedTokens;
    totalSaved += savings;
    blocksToSwap = i + 1;
  }

  if (blocksToSwap === 0) blocksToSwap = 1;

  // Always keep at least the last block raw
  if (blocksToSwap >= blocks.length) blocksToSwap = blocks.length - 1;
  if (blocksToSwap <= 0) {
    log("INFO", "Cannot swap without removing all blocks — cancelling");
    return { cancel: true };
  }

  const toSwap = blocks.slice(0, blocksToSwap);
  const toKeepRaw = blocks.slice(blocksToSwap);

  log("INFO", "Swap plan", {
    overflow,
    blocksToSwap,
    blocksKeptRaw: toKeepRaw.length,
    estimatedSavings: totalSaved
  });

  // firstKeptEntryId: first branchEntry of first raw block
  let firstKeptEntryId;
  if (toKeepRaw.length > 0) {
    firstKeptEntryId = toKeepRaw[0].firstEntryId;
  } else {
    firstKeptEntryId = branchEntries[branchEntries.length - 1].id;
  }

  if (!firstKeptEntryId) {
    log("ERROR", "Cannot determine firstKeptEntryId — cancelling");
    return { cancel: true };
  }

  // Preserve previous compressed content in history (first time only)
  if (compactionHistory.length === 0 && prevCompactionIndex >= 0) {
    const prevEntry = branchEntries[prevCompactionIndex];
    if (prevEntry.summary) {
      const prevTokens = estimateTokens(prevEntry.summary);
      compactionHistory.push({
        compressed: prevEntry.summary,
        tokensRaw: prevTokens,
        tokensCompressed: prevTokens,
        timestamp: Date.now() - 1
      });
      log("INFO", "Preserved previous compressed content", { tokens: prevTokens });
    }
  }

  if (signal?.aborted) return undefined;

  // Swap blocks: look up pre-compressed versions from cache
  let totalRaw = 0;
  let totalCompressed = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  const compressedSlots = [];
  const missedBlocks = [];

  for (let i = 0; i < toSwap.length; i++) {
    const block = toSwap[i];
    totalRaw += block.tokens;
    archiveRawBlock(block.hash, block.text);

    const cached = messageCache.get(block.hash);
    if (cached) {
      cacheHits++;
      compressedSlots.push({ hash: block.hash, result: cached });
    } else {
      cacheMisses++;
      // === DIAGNOSTIC: Log miss details for hash alignment debugging ===
      log("DEBUG", "=== DIAGNOSTIC: Cache miss ===", {
        blockIndex: i,
        hash: block.hash.slice(0, 8),
        tokens: block.tokens,
        textStart: block.text.slice(0, 80).replace(/\n/g, "\\n")
      });
      // === END DIAGNOSTIC ===
      missedBlocks.push({ text: block.text, hash: block.hash, tokens: block.tokens, slotIndex: compressedSlots.length });
      compressedSlots.push({ hash: block.hash, result: null });
    }
  }

  // Compress any cache misses on-demand (shouldn't happen often)
  if (missedBlocks.length > 0) {
    log("INFO", "Cache misses — compressing on-demand", { misses: missedBlocks.length });
    for (let i = 0; i < missedBlocks.length; i += config.maxParallelCompressions) {
      if (signal?.aborted) return undefined;
      const batch = missedBlocks.slice(i, i + config.maxParallelCompressions);
      const results = await Promise.all(batch.map(b => compressSingleBlock(b.text)));
      for (let j = 0; j < batch.length; j++) {
        const b = batch[j];
        const result = results[j] || { compressed: b.text, tokensRaw: b.tokens, tokensCompressed: b.tokens };
        messageCache.set(b.hash, result);
        compressedSlots[b.slotIndex] = { hash: b.hash, result };
      }
    }
  }

  if (signal?.aborted) return undefined;

  // Assemble compressed content from swapped blocks
  const compressedParts = [];
  for (const slot of compressedSlots) {
    if (slot.result) {
      compressedParts.push(slot.result.compressed);
      totalCompressed += slot.result.tokensCompressed;
    }
  }

  const newBlock = compressedParts.join("\n\n---\n\n");
  const newBlockTokens = estimateTokens(newBlock);

  compactionHistory.push({
    compressed: newBlock,
    tokensRaw: totalRaw,
    tokensCompressed: newBlockTokens,
    timestamp: Date.now()
  });

  // FIFO eviction at 80k (compressed blocks only)
  applyFifoEviction();
  saveCompactionHistory();
  saveMessageCache();

  // Build full compressed content from all history
  const histCompressed = compactionHistory.reduce((s, e) => s + e.tokensCompressed, 0);
  const histRaw = compactionHistory.reduce((s, e) => s + e.tokensRaw, 0);
  const contentParts = [
    `# R-Memory: Compressed Conversation History`,
    `_${compactionHistory.length} blocks | ~${histCompressed} tokens (was ~${histRaw} raw)_`,
    ""
  ];
  for (let i = 0; i < compactionHistory.length; i++) {
    const e = compactionHistory[i];
    contentParts.push(`## Block ${i + 1} [${new Date(e.timestamp).toISOString().slice(0, 16)}]`);
    contentParts.push(e.compressed);
    contentParts.push("");
  }
  const compressedContent = contentParts.join("\n");

  const saving = totalRaw > 0 ? ((1 - totalCompressed / totalRaw) * 100).toFixed(1) : "0";
  log("INFO", "=== DONE ===", {
    blocksSwapped: toSwap.length,
    blocksKeptRaw: toKeepRaw.length,
    raw: totalRaw,
    compressed: totalCompressed,
    saving: `${saving}%`,
    cacheHits,
    cacheMisses,
    contentTokens: estimateTokens(compressedContent),
    historyBlocks: compactionHistory.length,
    firstKeptId: firstKeptEntryId
  });

  return {
    compaction: {
      summary: compressedContent,   // OpenClaw names this "summary" — it's our compressed data
      firstKeptEntryId,
      tokensBefore,
      details: { readFiles: [], modifiedFiles: [] }
    }
  };
}

// ============================================================================
// Extension entry point
// ============================================================================
module.exports = function rMemoryExtension(api) {
  let initialized = false;

  function init() {
    if (initialized) return;
    initialized = true;
    workspaceDir = process.env.OPENCLAW_WORKSPACE || path.join(process.env.HOME, ".openclaw", "workspace");
    ensureDir(path.join(workspaceDir, config.storageDir));
    ensureDir(path.join(workspaceDir, config.archiveDir));
    loadConfig();
    loadMessageCache();
    resolvedApiKey = resolveApiKey();
    // Auto-select model if no key found for current provider
    if (!resolvedApiKey) {
      const autoModel = autoSelectCompressionModel();
      if (autoModel && autoModel !== config.compressionModel) {
        log("INFO", `Switching compression model: ${config.compressionModel} → ${autoModel} (key available)`);
        config.compressionModel = autoModel;
        // Persist the auto-selection
        try {
          const cfgPath = path.join(workspaceDir, config.storageDir, "config.json");
          const saved = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, "utf-8")) : {};
          saved.compressionModel = autoModel;
          fs.writeFileSync(cfgPath, JSON.stringify(saved, null, 2));
        } catch (e) { log("WARN", "Could not persist auto-selected model", { error: e.message }); }
        resolvedApiKey = resolveApiKey();
      }
    }
    log("INFO", "R-Memory V4.6.3 init", {
      workspace: workspaceDir,
      compressTrigger: config.compressTrigger,
      evictTrigger: config.evictTrigger,
      blockSize: config.blockSize,
      haiku: !!completeSimple,
      apiKey: !!resolvedApiKey,
      cachedBlocks: messageCache.size
    });
  }

  api.on("agent_start", () => {
    try { init(); lastProcessedBlockCount = 0; }
    catch (e) { console.error("[R-Memory] Init:", e.message); }
  });

  /**
   * Background compression: group messages into blocks (~4k each),
   * compress all complete blocks.
   * A block = messages from a turn, split at blockSize boundaries.
   * The last block is skipped (may still be in progress).
   */
  api.on("agent_end", async (event) => {
    try {
      init();
      if (!config.enabled) return;
      const messages = event.messages || [];
      if (messages.length === 0) return;

      // === DIAGNOSTIC: Log message roles from agent_end ===
      const roleCounts = {};
      let totalMsgTokens = 0;
      for (const msg of messages) {
        const r = msg.role || "unknown";
        roleCounts[r] = (roleCounts[r] || 0) + 1;
        totalMsgTokens += estimateTokens(extractMessageText(msg));
      }
      log("INFO", "=== DIAGNOSTIC: agent_end messages ===", {
        totalMessages: messages.length,
        roleCounts,
        totalTokensEstimate: totalMsgTokens
      });
      // === END DIAGNOSTIC ===

      const blocks = groupMessagesIntoBlocks(messages);

      // agent_end fires when the AI finishes responding — the turn IS complete.
      // Cache ALL blocks. queueBlock() deduplicates via hash check.
      // Log hashes so we can verify alignment with compaction path.
      const blockHashes = blocks.map(b => b.hash.slice(0, 8));
      for (const block of blocks) {
        queueBlock(block);
      }

      cleanupCache();
      log("DEBUG", "Queued blocks", {
        totalBlocks: blocks.length,
        blockHashes,
        queue: compressionQueue.length,
        cache: messageCache.size
      });
    } catch (e) { log("ERROR", "agent_end error", { error: e.message }); }
  });

  /**
   * Compaction interception: swap oldest raw blocks with pre-compressed versions.
   * On failure: returns {cancel: true} to PREVENT OpenClaw's lossy fallback.
   */
  api.on("session_before_compact", async (event) => {
    try { init(); return await handleBeforeCompact(event); }
    catch (e) {
      log("ERROR", "Handler error — CANCELLING to prevent lossy fallback", { error: e.message });
      return { cancel: true };
    }
  });
};
