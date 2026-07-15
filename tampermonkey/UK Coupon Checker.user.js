// ==UserScript==
// @name         UK Coupon Checker
// @namespace    https://github.com/darthvader666uk/uk-coupon-bot
// @version      1.1
// @description  Shows available UK coupon codes for the current store. Fetches from GitHub repo database.
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_notification
// @connect      raw.githubusercontent.com
// @connect      api.github.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  const GIST_RAW_URL = "https://raw.githubusercontent.com/darthvader666uk/uk-coupon-bot/main/data/uk-coupons.json";
  const GITHUB_REPO = "darthvader666uk/uk-coupon-bot";
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes (reduced for testing)
  const PANEL_KEY = "uk-coupon-panel";
  const POS_KEY = "uk-coupon-panel-pos";
  const FAILED_KEY = "uk-coupon-failed";

  // ─── STYLES ──────────────────────────────────────────────────────────────
  GM_addStyle(`
    #uk-coupon-badge {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 999999;
      background: #1a1a2e;
      color: #e94560;
      border: 2px solid #e94560;
      border-radius: 50%;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 16px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(233, 69, 96, 0.4);
      transition: all 0.2s ease;
      user-select: none;
    }
    #uk-coupon-badge:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 20px rgba(233, 69, 96, 0.6);
    }
    #uk-coupon-badge.no-codes {
      background: #1a1a2e;
      color: #666;
      border-color: #444;
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
      cursor: default;
    }

    #uk-coupon-panel {
      position: fixed;
      top: 76px;
      right: 20px;
      z-index: 999998;
      width: 380px;
      max-height: 500px;
      background: #1a1a2e;
      color: #eee;
      border: 1px solid #333;
      border-radius: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
      display: none;
      overflow: hidden;
    }
    #uk-coupon-panel.open { display: block; }

    .ukcp-header {
      padding: 14px 16px;
      background: #16213e;
      border-bottom: 1px solid #333;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .ukcp-header h3 {
      margin: 0;
      font-size: 14px;
      color: #e94560;
    }
    .ukcp-header .ukcp-close {
      cursor: pointer;
      color: #888;
      font-size: 18px;
      line-height: 1;
    }
    .ukcp-header .ukcp-close { cursor: pointer; color: #888; font-size: 18px; line-height: 1; }
    .ukcp-header .ukcp-close:hover { color: #fff; }
    .ukcp-header .ukcp-refresh {
      cursor: pointer;
      color: #888;
      font-size: 16px;
      margin-right: 8px;
      transition: color 0.15s;
    }
    .ukcp-header .ukcp-refresh:hover { color: #4caf50; }

    .ukcp-meta {
      padding: 8px 16px;
      font-size: 11px;
      color: #666;
      border-bottom: 1px solid #222;
    }

    .ukcp-codes {
      max-height: 350px;
      overflow-y: auto;
      padding: 8px 0;
    }
    .ukcp-codes::-webkit-scrollbar { width: 6px; }
    .ukcp-codes::-webkit-scrollbar-track { background: #1a1a2e; }
    .ukcp-codes::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

    .ukcp-code-item {
      padding: 10px 16px;
      border-bottom: 1px solid #222;
      cursor: pointer;
      transition: background 0.15s;
    }
    .ukcp-code-item:hover { background: #16213e; }
    .ukcp-code-item:last-child { border-bottom: none; }

    .ukcp-code-text {
      font-family: "SF Mono", "Fira Code", monospace;
      font-size: 14px;
      font-weight: 700;
      color: #e94560;
      letter-spacing: 1px;
    }
    .ukcp-code-desc {
      font-size: 11px;
      color: #aaa;
      margin-top: 4px;
      line-height: 1.4;
    }
    .ukcp-code-meta {
      font-size: 10px;
      color: #555;
      margin-top: 4px;
      display: flex;
      gap: 10px;
    }
    .ukcp-code-meta span { display: inline-flex; align-items: center; gap: 3px; }

    .ukcp-copy-btn {
      background: #e94560;
      color: #fff;
      border: none;
      padding: 4px 10px;
      border-radius: 4px;
      font-size: 11px;
      cursor: pointer;
      margin-top: 6px;
    }
    .ukcp-copy-btn:hover { background: #c73652; }

    .ukcp-fail-btn {
      background: transparent;
      color: #666;
      border: 1px solid #444;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 10px;
      cursor: pointer;
      margin-top: 6px;
      margin-left: 6px;
    }
    .ukcp-fail-btn:hover { color: #e94560; border-color: #e94560; }

    .ukcp-empty {
      padding: 30px 16px;
      text-align: center;
      color: #555;
    }

    .ukcp-copied {
      position: fixed;
      top: 76px;
      right: 20px;
      z-index: 9999999;
      background: #16213e;
      color: #4caf50;
      border: 1px solid #4caf50;
      border-radius: 8px;
      padding: 8px 16px;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      animation: ukcpFade 2s forwards;
    }
    @keyframes ukcpFade {
      0%, 70% { opacity: 1; }
      100% { opacity: 0; pointer-events: none; }
    }
  `);

  // ─── HOSTNAME MATCHING ───────────────────────────────────────────────────
  function getCurrentDomain() {
    return window.location.hostname.toLowerCase().replace(/^www\./, "");
  }

  // Gaming CD key store domains
  const GAMING_DOMAINS = [
    "driffle.com", "player.land", "kinguin.net", "g2a.com", "gamivo.com",
    "k4g.com", "g2play.com", "yuplay.com", "greenmangaming.com",
    "fanatical.com", "gamesplanet.com", "gamersgate.com", "gamebillet.com",
    "2game.com", "allyouplay.com", "loaded.com", "gameboost.com",
    "difmark.com", "hrkgame.com", "lootbar.gg", "eldorado.gg",
    "gameseal.com", "premiumcdkeys.com", "keycense.com", "playsum.com",
    "joybuggy.com", "nuuvem.com", "wingamestore.com",
    "store.ubisoft.com", "ea.com", "epicgames.com", "gog.com",
    "humblebundle.com", "store.steampowered.com",
    "game.co.uk", "shopto.net", "razerzone.com",
  ];

  function matchStore(domain, stores) {
    console.log("[UK Coupon Checker] matchStore called with domain:", domain);

    // Direct match (e.g., "g2a.com" in stores)
    if (stores[domain]) {
      console.log("[UK Coupon Checker] Direct match found:", domain);
      return stores[domain];
    }

    // Try with www. prefix stripped (already done by getCurrentDomain)
    // Try common variations
    const variations = [
      domain,
      domain.replace(/^www\./, ""),
      "www." + domain,
    ];
    for (const v of variations) {
      if (stores[v]) {
        console.log("[UK Coupon Checker] Variation match found:", v);
        return stores[v];
      }
    }

    // Try with .co.uk suffix
    if (stores[domain + ".co.uk"]) {
      console.log("[UK Coupon Checker] .co.uk match found:", domain + ".co.uk");
      return stores[domain + ".co.uk"];
    }

    // Partial match: check if any store key is contained in the domain
    for (const [key, store] of Object.entries(stores)) {
      const keyBase = key.replace(/\.co\.uk$/, "").replace(/\./g, "");
      const domainClean = domain.replace(/\./g, "");
      if (domain.includes(keyBase) || keyBase.includes(domainClean) || domainClean.includes(keyBase)) {
        console.log("[UK Coupon Checker] Partial match found:", key);
        return store;
      }
    }

    // Gaming domain match: check if current site is a known gaming store
    console.log("[UK Coupon Checker] Checking gaming domains…");
    for (const gamingDomain of GAMING_DOMAINS) {
      if (domain.includes(gamingDomain) || gamingDomain.includes(domain)) {
        console.log("[UK Coupon Checker] Gaming domain matched:", gamingDomain);
        // Find store-specific codes first (exact domain match)
        const storeKey = Object.keys(stores).find(k =>
          k === gamingDomain || gamingDomain.includes(k.replace(/^www\./, ""))
        );
        if (storeKey && stores[storeKey] && stores[storeKey].codes?.length > 0) {
          console.log("[UK Coupon Checker] Store-specific match:", storeKey, stores[storeKey].codes.length, "codes");
          return stores[storeKey];
        }

        // Fallback: find all gaming codes from this specific store
        const gamingCodes = [];
        for (const [key, store] of Object.entries(stores)) {
          if (store.codes && key.includes(gamingDomain.split(".")[0])) {
            gamingCodes.push(...store.codes);
          }
        }
        if (gamingCodes.length > 0) {
          console.log("[UK Coupon Checker] Fallback gaming match:", gamingCodes.length, "codes");
          return { name: "Gaming Store", codes: gamingCodes };
        }
      }
    }

    console.log("[UK Coupon Checker] No match found for:", domain);
    return null;
  }

  // ─── DATA FETCHING ───────────────────────────────────────────────────────
  function fetchDatabase() {
    return new Promise((resolve, reject) => {
      // Check cache first
      const cached = GM_getValue("coupon_cache");
      const cacheTime = GM_getValue("coupon_cache_time", 0);
      if (cached && Date.now() - cacheTime < CACHE_TTL_MS) {
        console.log("[UK Coupon Checker] Using cached data (" + Math.round((Date.now() - cacheTime) / 60000) + " min old)");
        resolve(cached);
        return;
      }

      console.log("[UK Coupon Checker] Fetching fresh data from GitHub…");

      GM_xmlhttpRequest({
        method: "GET",
        url: GIST_RAW_URL,
        onload: function (res) {
          if (res.status === 200) {
            try {
              const data = JSON.parse(res.responseText);
              GM_setValue("coupon_cache", data);
              GM_setValue("coupon_cache_time", Date.now());
              resolve(data);
            } catch (e) {
              reject(new Error("Invalid JSON"));
            }
          } else {
            reject(new Error(`HTTP ${res.status}`));
          }
        },
        onerror: function () {
          reject(new Error("Network error"));
        },
      });
    });
  }

  // ─── CHECKOUT AUTO-FILL ──────────────────────────────────────────────────
  function findCheckoutInput() {
    const selectors = [
      'input[name*="promo" i]',
      'input[name*="coupon" i]',
      'input[name*="discount" i]',
      'input[name*="voucher" i]',
      'input[name*="code" i]',
      'input[placeholder*="promo" i]',
      'input[placeholder*="coupon" i]',
      'input[placeholder*="discount" i]',
      'input[placeholder*="voucher" i]',
      'input[id*="promo" i]',
      'input[id*="coupon" i]',
      'input[id*="discount" i]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function autoFillCode(code) {
    const input = findCheckoutInput();
    if (input) {
      // Clear existing value
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      ).set;
      nativeInputValueSetter.call(input, code);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  }

  // ─── COPY TO CLIPBOARD ───────────────────────────────────────────────────
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    }
  }

  function showCopiedToast(text, filled) {
    const toast = document.createElement("div");
    toast.className = "ukcp-copied";
    toast.textContent = filled ? `Copied "${text}" + auto-filled!` : `Copied "${text}"`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  }

  // ─── FAILED CODES ────────────────────────────────────────────────────────
  function getFailedCodes() {
    return GM_getValue(FAILED_KEY, {});
  }

  function markCodeFailed(code, storeDomain) {
    const failed = getFailedCodes();
    if (!failed[storeDomain]) failed[storeDomain] = [];
    if (!failed[storeDomain].includes(code)) failed[storeDomain].push(code);
    GM_setValue(FAILED_KEY, failed);
  }

  function isCodeFailed(code, storeDomain) {
    const failed = getFailedCodes();
    return failed[storeDomain]?.includes(code) || false;
  }

  // ─── REPORT FAILED ───────────────────────────────────────────────────────
  function reportFailed(code, storeDomain) {
    const reason = prompt(`Report "${code}" as failed at ${storeDomain}.\nOptional — describe what happened:`);
    if (reason === null) return; // cancelled

    // Store locally so code stays hidden
    markCodeFailed(code, storeDomain);

    GM_xmlhttpRequest({
      method: "POST",
      url: `https://api.github.com/repos/${GITHUB_REPO}/issues`,
      headers: {
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      data: JSON.stringify({
        title: `❌ Code failed: ${code} @ ${storeDomain}`,
        body: [
          "## Failed Code Report (via Tampermonkey)",
          "",
          `- **Code:** \`${code}\``,
          `- **Store:** ${storeDomain}`,
          `- **Reason:** ${reason || "Not specified"}`,
          `- **URL:** ${window.location.href}`,
          `- **Reported:** ${new Date().toISOString()}`,
        ].join("\n"),
        labels: ["failed-code"],
      }),
      onload: function (res) {
        if (res.status === 201) {
          GM_notification({ title: "UK Coupon Checker", text: `Reported "${code}" as failed — hidden from now on`, timeout: 3000 });
        }
      },
    });
  }

  // ─── UI ──────────────────────────────────────────────────────────────────
  function buildPanel(codes, storeData, domain) {
    // Remove existing panel
    document.getElementById("uk-coupon-panel")?.remove();
    document.getElementById("uk-coupon-badge")?.remove();

    if (!codes || codes.length === 0) return;

    // Filter failed codes early for badge/meta
    const visibleCodes = codes.filter(c => !isCodeFailed(c.code, domain));

    // Badge
    const badge = document.createElement("div");
    badge.id = "uk-coupon-badge";
    badge.textContent = visibleCodes.length;
    badge.title = `${visibleCodes.length} codes available for this store`;
    badge.addEventListener("click", togglePanel);
    document.body.appendChild(badge);

    // Panel
    const panel = document.createElement("div");
    panel.id = "uk-coupon-panel";

    // Restore position
    const savedPos = GM_getValue(POS_KEY);
    if (savedPos) {
      panel.style.bottom = savedPos.bottom || "80px";
      panel.style.right = savedPos.right || "20px";
    }

    // Header
    const header = document.createElement("div");
    header.className = "ukcp-header";
    header.innerHTML = `<h3>🎟 ${storeData.name || domain}</h3>`;

    // Refresh button
    const refreshBtn = document.createElement("span");
    refreshBtn.className = "ukcp-refresh";
    refreshBtn.textContent = "↻";
    refreshBtn.title = "Refresh codes from server";
    refreshBtn.addEventListener("click", async () => {
      refreshBtn.textContent = "⏳";
      GM_setValue("coupon_cache", null);
      GM_setValue("coupon_cache_time", 0);
      try {
        const fresh = await fetchDatabase();
        const newDomain = getCurrentDomain();
        const newStore = matchStore(newDomain, fresh.stores);
        if (newStore && newStore.codes?.length > 0) {
          const sorted = [...newStore.codes].sort((a, b) => {
            const rateA = (a.testResults?.worked || 0) / Math.max(a.testResults?.total || 1, 1);
            const rateB = (b.testResults?.worked || 0) / Math.max(b.testResults?.total || 1, 1);
            return rateB - rateA;
          });
          buildPanel(sorted, newStore, newDomain);
        } else {
          document.getElementById("uk-coupon-panel")?.remove();
          document.getElementById("uk-coupon-badge")?.remove();
        }
      } catch (e) {
        refreshBtn.textContent = "✗";
        setTimeout(() => { refreshBtn.textContent = "↻"; }, 1500);
      }
    });
    header.appendChild(refreshBtn);

    // Close button
    const closeBtn = document.createElement("span");
    closeBtn.className = "ukcp-close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", togglePanel);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // Meta
    const meta = document.createElement("div");
    meta.className = "ukcp-meta";
    const lastUpdated = storeData.codes?.[0]?.lastSeen || "";
    const failedCount = codes.length - visibleCodes.length;
    meta.textContent = `${visibleCodes.length} codes${failedCount > 0 ? ` (${failedCount} hidden)` : ""} · Updated: ${lastUpdated ? new Date(lastUpdated).toLocaleDateString("en-GB") : "unknown"}`;
    panel.appendChild(meta);

    // Codes list — filter out locally reported failures
    const codesDiv = document.createElement("div");
    codesDiv.className = "ukcp-codes";

    if (visibleCodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ukcp-empty";
      empty.textContent = "All codes marked as failed. Refresh to re-check.";
      codesDiv.appendChild(empty);
    }

    for (const c of visibleCodes) {
      const item = document.createElement("div");
      item.className = "ukcp-code-item";

      const worked = c.testResults?.worked || 0;
      const total = c.testResults?.total || 0;
      const rate = total > 0 ? Math.round((worked / total) * 100) : null;

      item.innerHTML = `
        <div class="ukcp-code-text">${escapeHtml(c.code)}</div>
        <div class="ukcp-code-desc">${escapeHtml(c.description || "")}</div>
        <div class="ukcp-code-meta">
          ${c.type !== "unknown" ? `<span>📋 ${c.type}</span>` : ""}
          ${rate !== null ? `<span>✅ ${rate}% success</span>` : ""}
          ${c.expiry ? `<span>⏰ ${c.expiry}</span>` : ""}
          <span>📡 ${c.source || "unknown"}</span>
        </div>
      `;

      // Copy button
      const copyBtn = document.createElement("button");
      copyBtn.className = "ukcp-copy-btn";
      copyBtn.textContent = "📋 Copy Code";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const filled = autoFillCode(c.code);
        await copyToClipboard(c.code);
        showCopiedToast(c.code, filled);
      });
      item.appendChild(copyBtn);

      // Fail button
      const failBtn = document.createElement("button");
      failBtn.className = "ukcp-fail-btn";
      failBtn.textContent = "❌ Not working";
      failBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        reportFailed(c.code, domain);
      });
      item.appendChild(failBtn);

      codesDiv.appendChild(item);
    }

    panel.appendChild(codesDiv);
    document.body.appendChild(panel);
  }

  function togglePanel() {
    const panel = document.getElementById("uk-coupon-panel");
    if (panel) {
      panel.classList.toggle("open");
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ─── MAIN ────────────────────────────────────────────────────────────────
  async function main() {
    // Don't run on chrome://, about:, etc.
    if (!window.location.protocol.startsWith("http")) return;

    console.log("[UK Coupon Checker] Running on " + window.location.hostname);

    try {
      const database = await fetchDatabase();
      if (!database?.stores) {
        console.log("[UK Coupon Checker] No stores in database");
        return;
      }

      const domain = getCurrentDomain();
      console.log("[UK Coupon Checker] Domain: " + domain);
      console.log("[UK Coupon Checker] Store keys: " + Object.keys(database.stores).join(", "));

      const storeData = matchStore(domain, database.stores);

      if (storeData && storeData.codes?.length > 0) {
        // Sort by success rate (highest first), then by most recent
        const sorted = [...storeData.codes].sort((a, b) => {
          const rateA = (a.testResults?.worked || 0) / Math.max(a.testResults?.total || 1, 1);
          const rateB = (b.testResults?.worked || 0) / Math.max(b.testResults?.total || 1, 1);
          return rateB - rateA;
        });

        buildPanel(sorted, storeData, domain);
        console.log(`[UK Coupon Checker] Found ${sorted.length} codes for ${domain}`);
      } else {
        console.log("[UK Coupon Checker] No codes found for " + domain);
      }
    } catch (err) {
      console.log(`[UK Coupon Checker] Error: ${err.message}`);
    }
  }

  main();
})();
