// ==UserScript==
// @name         UK Coupon Checker
// @namespace    https://github.com/darthvader666uk/uk-coupon-bot
// @version      2.2.0
// @description  Shows available UK coupon codes for the current store. Copies a code and fills the promo box for you — you press Apply.
// @updateURL    https://raw.githubusercontent.com/darthvader666uk/uk-coupon-bot/main/tampermonkey/UK%20Coupon%20Checker.user.js
// @downloadURL  https://raw.githubusercontent.com/darthvader666uk/uk-coupon-bot/main/tampermonkey/UK%20Coupon%20Checker.user.js
// @match        https://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_openInTab
// @connect      raw.githubusercontent.com
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Design notes (v2 rewrite)
 * ────────────────────────
 * v1 tried to automate the whole checkout: find the promo box, find the Apply
 * button, click it, then read the page to decide whether the code worked. Every
 * one of those steps was a guess, and the failure mode of a wrong guess is
 * clicking "Place order". v2 does the part that can be done reliably — tell you
 * which codes exist, copy one, and fill the box — and leaves the click to you.
 *
 * Deliberately removed: auto-apply, auto-try-all, page-text result detection,
 * savings tracking, the notification toast, panel dragging, and the in-page
 * self-updater. None of them worked; several were unreachable code.
 *
 * Store matching is exact (plus the alias table shipped in index.json). v1 fell
 * back to substring matching, so store key "very.co.uk" matched delivery.com.
 *
 * Data is sharded: index.json holds domain -> code count plus aliases, and each
 * store has its own file. Only the store for the current site is fetched.
 */

(function () {
  "use strict";

  // ─── CONFIG ──────────────────────────────────────────────────────────────
  const DATA_BASE = "https://raw.githubusercontent.com/darthvader666uk/uk-coupon-bot/main/data";
  const INDEX_URL = `${DATA_BASE}/index.json`;
  const STORE_URL = (domain) => `${DATA_BASE}/stores/${encodeURIComponent(domain)}.json`;
  const REPO = "darthvader666uk/uk-coupon-bot";
  const INDEX_TTL_MS = 24 * 60 * 60 * 1000; // index is tiny and changes daily
  const STORE_TTL_MS = 6 * 60 * 60 * 1000;
  const INDEX_KEY = "ukcp_index";
  const INDEX_TIME_KEY = "ukcp_index_time";
  const STORE_KEY = (domain) => `ukcp_store_${domain}`;
  const STORE_TIME_KEY = (domain) => `ukcp_store_time_${domain}`;
  const STALE_AFTER_DAYS = 21;
  const HIDDEN_SITES_KEY = "ukcp_hidden_sites";
  const VOTES_KEY = "ukcp_votes";

  // ─── SMALL HELPERS ───────────────────────────────────────────────────────
  const log = (...args) => console.log("[UK Coupon Checker]", ...args);

  function currentHost() {
    return location.hostname.toLowerCase().replace(/^www\./, "");
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function daysAgo(dateString) {
    if (!dateString) return null;
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return null;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    if (days < 1) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
  }

  function discountLabel(code) {
    if (code.type === "percentage" && code.value != null) return `${code.value}% off`;
    if (code.type === "fixed" && code.value != null) return `£${code.value} off`;
    if (code.type === "free_shipping") return "Free delivery";
    if (code.type === "bogo") return "BOGO";
    return null;
  }

  // ─── PERSISTED STATE ─────────────────────────────────────────────────────
  function readObject(key) {
    const raw = GM_getValue(key, null);
    if (!raw) return {};
    if (typeof raw === "object") return raw;
    try {
      return JSON.parse(raw) || {};
    } catch {
      return {};
    }
  }

  function isSiteHidden(host) {
    return readObject(HIDDEN_SITES_KEY)[host] === true;
  }

  function setSiteHidden(host, hidden) {
    const sites = readObject(HIDDEN_SITES_KEY);
    if (hidden) sites[host] = true;
    else delete sites[host];
    GM_setValue(HIDDEN_SITES_KEY, sites);
  }

  /** Votes are keyed `domain::CODE` -> "up" | "down". */
  function getVote(domain, code) {
    return readObject(VOTES_KEY)[`${domain}::${code}`] || null;
  }

  function setVote(domain, code, vote) {
    const votes = readObject(VOTES_KEY);
    const key = `${domain}::${code}`;
    if (vote) votes[key] = vote;
    else delete votes[key];
    GM_setValue(VOTES_KEY, votes);
  }

  // ─── STORE MATCHING ──────────────────────────────────────────────────────
  /**
   * Resolve the current hostname to a store key, walking up the subdomain
   * chain so checkout.currys.co.uk finds currys.co.uk.
   *
   * Exact matches and the index's alias table only — no substring fallback.
   * The aliases are shipped in index.json rather than copied into this file;
   * a second hand-synced table was a standing source of "why isn't this store
   * matching" bugs.
   */
  function resolveDomain(host, indexStores, aliases) {
    const parts = host.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      const mapped = aliases[candidate];
      if (mapped && indexStores[mapped]) return mapped;
      if (indexStores[candidate]) return candidate;
    }
    return null;
  }

  /**
   * Past its stated end date. Retailers often leave codes working afterwards,
   * so this ranks a code last and warns — it never hides it.
   */
  function isExpired(code) {
    if (!code.expiry) return false;
    return code.expiry < new Date().toISOString().slice(0, 10);
  }

  function isStale(code) {
    if (!code.lastSeen) return false;
    const seen = new Date(code.lastSeen).getTime();
    if (isNaN(seen)) return false;
    return Date.now() - seen > STALE_AFTER_DAYS * 86400000;
  }

  /**
   * Lower sorts first. Your own verdict outranks everything else: a code you
   * marked as not working has no business sitting at the top of the list, and
   * one you confirmed should lead.
   */
  function rankOf(code) {
    const vote = getVote(state.domain, code.code);
    if (vote === "down") return 3;
    if (isExpired(code)) return 2;
    if (vote === "up") return 0;
    return 1;
  }

  function sortCodes(codes) {
    // No code in the database has test results yet, so sorting by success rate
    // was a no-op in v1. Sort by what we actually know: your own votes, then
    // how recently a source still listed the code, then how many sources agree.
    return [...codes].sort((a, b) => {
      const rankA = rankOf(a);
      const rankB = rankOf(b);
      if (rankA !== rankB) return rankA - rankB;
      const seenA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
      const seenB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
      if (seenB !== seenA) return seenB - seenA;
      return (b.sources?.length || 0) - (a.sources?.length || 0);
    });
  }

  // ─── DATA FETCHING ───────────────────────────────────────────────────────
  /*
   * The database is sharded: a small index of domain -> code count, and one
   * file per store. A single combined file would be several MB once the
   * database grows, re-downloaded by every browser on a timer to show a dozen
   * codes. This way the per-page cost stays flat however large it gets.
   */
  function fetchJSON(url, { cacheKey, timeKey, ttl, force }) {
    return new Promise((resolve, reject) => {
      if (!force && cacheKey) {
        const cached = GM_getValue(cacheKey, null);
        const cachedAt = GM_getValue(timeKey, 0);
        if (cached && Date.now() - cachedAt < ttl) {
          try {
            resolve(typeof cached === "string" ? JSON.parse(cached) : cached);
            return;
          } catch {
            /* fall through to a fresh fetch */
          }
        }
      }

      GM_xmlhttpRequest({
        method: "GET",
        url,
        onload: (res) => {
          if (res.status !== 200) {
            reject(new Error(`HTTP ${res.status}`));
            return;
          }
          try {
            const data = JSON.parse(res.responseText);
            if (cacheKey) {
              GM_setValue(cacheKey, data);
              GM_setValue(timeKey, Date.now());
            }
            resolve(data);
          } catch {
            reject(new Error("Invalid JSON"));
          }
        },
        onerror: () => reject(new Error("Network error")),
      });
    });
  }

  function fetchIndex(force) {
    return fetchJSON(INDEX_URL, {
      cacheKey: INDEX_KEY,
      timeKey: INDEX_TIME_KEY,
      ttl: INDEX_TTL_MS,
      force,
    });
  }

  function fetchStore(domain, force) {
    return fetchJSON(STORE_URL(domain), {
      cacheKey: STORE_KEY(domain),
      timeKey: STORE_TIME_KEY(domain),
      ttl: STORE_TTL_MS,
      force,
    });
  }

  // ─── PROMO INPUT DETECTION ───────────────────────────────────────────────
  /*
   * v1 took the first `input[name*="code" i]` on the page, which happily
   * matched postcode and gift-card fields, hidden inputs included. v2 scores
   * every visible text input and requires a positive score, so when it isn't
   * confident it fills nothing and says so.
   */
  const PROMO_RE = /promo|coupon|voucher|discount|offer[\s_-]?code|promotion/i;
  const REJECT_RE = /post[\s_-]?code|postal|zip|country|search|email|phone|mobile|address|card[\s_-]?number|cardnum|cvv|cvc|expiry|quantity|password|first[\s_-]?name|last[\s_-]?name|town|city|county/i;

  function collectInputs(root, out) {
    for (const el of root.querySelectorAll("input, textarea")) {
      out.push(el);
      if (el.shadowRoot) collectInputs(el.shadowRoot, out);
    }
    // Open shadow roots are common on modern checkout components.
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) collectInputs(el.shadowRoot, out);
    }
    return out;
  }

  function isUsableInput(el) {
    if (el.disabled || el.readOnly) return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (!["text", "search", "tel", ""].includes(type) && el.tagName !== "TEXTAREA") return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 10) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    return true;
  }

  /** All the text a human would associate with this input. */
  function inputContext(el) {
    const bits = [
      el.name,
      el.id,
      el.placeholder,
      el.getAttribute("aria-label"),
      el.getAttribute("data-testid"),
      el.className,
    ];
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) {
        bits.push(document.getElementById(id)?.textContent);
      }
    }
    if (el.id) {
      bits.push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent);
    }
    bits.push(el.closest("label")?.textContent);
    return bits.filter(Boolean).join(" ");
  }

  function scoreInput(el) {
    const context = inputContext(el);
    if (!context) return 0;
    if (REJECT_RE.test(context)) return 0;
    if (!PROMO_RE.test(context)) return 0;

    let score = 1;
    // A direct name/id hit beats a match that only appeared in a class name.
    if (PROMO_RE.test(el.name || "") || PROMO_RE.test(el.id || "")) score += 3;
    if (PROMO_RE.test(el.placeholder || "")) score += 2;
    if (el.closest("form")) score += 1;
    return score;
  }

  function findPromoInput() {
    let best = null;
    let bestScore = 0;
    for (const el of collectInputs(document, [])) {
      if (!isUsableInput(el)) continue;
      const score = scoreInput(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    return best;
  }

  /**
   * Set the value in a way React/Vue controlled inputs actually notice.
   * Never clicks anything — the user presses the site's own Apply button.
   */
  function fillInput(el, value) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.focus();
    el.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Clipboard API needs a secure context and permission; fall back.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;top:-9999px;opacity:0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      ta.remove();
      return ok;
    }
  }

  // ─── STYLES ──────────────────────────────────────────────────────────────
  /* Injected only after a store match, so unmatched sites pay nothing. */
  function injectStyles() {
    GM_addStyle(`
      #ukcp-badge, #ukcp-panel {
        --ukcp-bg: #1a1a2e;
        --ukcp-surface: #16213e;
        --ukcp-accent: #e94560;
        --ukcp-text: #eeeeee;
        --ukcp-muted: #9aa0b4;
        --ukcp-border: #2c3252;
        --ukcp-green: #4caf50;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        box-sizing: border-box;
      }
      #ukcp-badge *, #ukcp-panel * { box-sizing: border-box; }

      #ukcp-badge {
        position: fixed; bottom: 20px; right: 20px; z-index: 2147483000;
        width: 52px; height: 52px; border-radius: 50%;
        background: var(--ukcp-accent); color: #fff;
        display: flex; align-items: center; justify-content: center;
        font-size: 15px; font-weight: 700; cursor: pointer;
        box-shadow: 0 6px 20px rgba(0,0,0,.4);
        border: none; transition: transform .15s ease;
      }
      #ukcp-badge:hover { transform: scale(1.08); }

      #ukcp-panel {
        position: fixed; bottom: 84px; right: 20px; z-index: 2147483000;
        width: 380px; max-width: calc(100vw - 40px); max-height: 70vh;
        background: var(--ukcp-bg); color: var(--ukcp-text);
        border: 1px solid var(--ukcp-border); border-radius: 14px;
        box-shadow: 0 16px 48px rgba(0,0,0,.5);
        font-size: 13px; overflow: hidden;
        display: none; flex-direction: column;
      }
      #ukcp-panel.ukcp-open { display: flex; }

      .ukcp-head {
        display: flex; align-items: center; gap: 10px;
        padding: 14px 16px; background: var(--ukcp-surface);
        border-bottom: 1px solid var(--ukcp-border);
      }
      .ukcp-head img { width: 28px; height: 28px; border-radius: 6px; background: #fff; padding: 2px; flex-shrink: 0; }
      .ukcp-head-text { flex: 1; min-width: 0; }
      .ukcp-head h3 { margin: 0; font-size: 14px; color: #fff; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ukcp-head-sub { font-size: 11px; color: var(--ukcp-muted); margin-top: 2px; }
      .ukcp-icon-btn {
        background: none; border: none; color: var(--ukcp-muted);
        cursor: pointer; font-size: 15px; padding: 4px; line-height: 1; border-radius: 4px;
      }
      .ukcp-icon-btn:hover { color: #fff; background: rgba(255,255,255,.08); }

      .ukcp-status {
        padding: 8px 16px; font-size: 11px; color: var(--ukcp-muted);
        background: rgba(0,0,0,.2); border-bottom: 1px solid var(--ukcp-border);
      }
      .ukcp-status.ukcp-ok { color: var(--ukcp-green); }

      .ukcp-list { overflow-y: auto; flex: 1; padding: 6px; }
      .ukcp-item {
        display: flex; align-items: center; gap: 10px;
        padding: 10px; border-radius: 10px; margin-bottom: 4px;
        background: var(--ukcp-surface); border: 1px solid transparent;
      }
      .ukcp-item:hover { border-color: var(--ukcp-border); }
      .ukcp-item.ukcp-voted-down { opacity: .45; }
      .ukcp-item-main { flex: 1; min-width: 0; cursor: pointer; }
      .ukcp-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 13px; font-weight: 700; color: #fff; letter-spacing: .4px;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .ukcp-desc { font-size: 11px; color: var(--ukcp-muted); margin-top: 3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .ukcp-tags { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
      .ukcp-tag {
        font-size: 10px; padding: 2px 6px; border-radius: 4px;
        background: rgba(255,255,255,.07); color: var(--ukcp-muted);
      }
      .ukcp-tag.ukcp-value { background: rgba(76,175,80,.15); color: var(--ukcp-green); }
      .ukcp-tag.ukcp-stale { background: rgba(255,152,0,.15); color: #ff9800; }
      .ukcp-tag.ukcp-expired { background: rgba(244,67,54,.15); color: #f44336; }
      .ukcp-votes { display: flex; gap: 2px; flex-shrink: 0; }
      .ukcp-vote {
        background: none; border: none; cursor: pointer; font-size: 13px;
        padding: 3px 5px; border-radius: 5px; opacity: .5;
      }
      .ukcp-vote:hover { opacity: 1; background: rgba(255,255,255,.08); }
      .ukcp-vote.ukcp-active { opacity: 1; background: rgba(255,255,255,.14); }

      .ukcp-foot {
        padding: 10px 16px; border-top: 1px solid var(--ukcp-border);
        background: var(--ukcp-surface); display: flex; justify-content: space-between;
        align-items: center; font-size: 11px; color: var(--ukcp-muted);
      }
      .ukcp-link { background: none; border: none; color: var(--ukcp-muted); cursor: pointer; font-size: 11px; text-decoration: underline; padding: 0; }
      .ukcp-link:hover { color: #fff; }
      .ukcp-empty { padding: 24px 16px; text-align: center; color: var(--ukcp-muted); font-size: 12px; }
    `);
  }

  // ─── UI ──────────────────────────────────────────────────────────────────
  const state = {
    domain: null,
    storeName: null,
    codes: [],
    panel: null,
    badge: null,
  };

  function setStatus(message, ok) {
    const el = state.panel?.querySelector(".ukcp-status");
    if (!el) return;
    el.textContent = message;
    el.className = "ukcp-status" + (ok ? " ukcp-ok" : "");
  }

  function visibleCodes() {
    return state.codes.filter((c) => getVote(state.domain, c.code) !== "down");
  }

  function togglePanel(force) {
    if (!state.panel) return;
    const open = force !== undefined ? force : !state.panel.classList.contains("ukcp-open");
    state.panel.classList.toggle("ukcp-open", open);
    if (open) refreshStatusForPage();
  }

  function refreshStatusForPage() {
    const input = findPromoInput();
    if (input) setStatus("Promo box found — click a code to copy and fill it.", true);
    else setStatus("Click a code to copy it. No promo box detected on this page.");
  }

  /** Click a code: always copy, fill only when we're confident about the box. */
  async function useCode(codeObj) {
    const copied = await copyToClipboard(codeObj.code);
    const input = findPromoInput();

    if (input) {
      fillInput(input, codeObj.code);
      setStatus(`"${codeObj.code}" copied and filled — now press the site's Apply button.`, true);
    } else if (copied) {
      setStatus(`"${codeObj.code}" copied. Paste it into the promo box yourself.`, true);
    } else {
      setStatus(`Couldn't copy automatically — select and copy "${codeObj.code}" manually.`);
    }
  }

  function reportFailedCode(code) {
    const title = `❌ Code failed: ${code} @ ${state.domain}`;
    const body = [
      `**Code:** \`${code}\``,
      `**Store:** ${state.domain}`,
      `**Page:** ${location.origin}${location.pathname}`,
      "",
      "Reported from the UK Coupon Checker userscript.",
    ].join("\n");
    const url =
      `https://github.com/${REPO}/issues/new` +
      `?labels=failed-code&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    // Opened rather than POSTed: creating the issue directly would need a
    // GitHub token stored in the browser. The scraper picks these up on its
    // next run via fetchFailedCodeIssues().
    if (typeof GM_openInTab === "function") GM_openInTab(url, { active: true });
    else window.open(url, "_blank");
  }

  function handleVote(codeObj, vote) {
    const current = getVote(state.domain, codeObj.code);
    const next = current === vote ? null : vote;
    setVote(state.domain, codeObj.code, next);

    // Re-rank so a rejected code drops to the bottom immediately rather than
    // sitting at the top greyed out.
    state.codes = sortCodes(state.codes);
    renderList();

    if (next === "down") {
      setStatus(`"${codeObj.code}" moved to the bottom. Report it so it gets removed?`);
      const foot = state.panel.querySelector(".ukcp-report-slot");
      if (foot) {
        foot.innerHTML = "";
        const btn = document.createElement("button");
        btn.className = "ukcp-link";
        btn.textContent = `Report ${codeObj.code}`;
        btn.addEventListener("click", () => {
          reportFailedCode(codeObj.code);
          foot.innerHTML = "";
        });
        foot.appendChild(btn);
      }
    } else if (next === "up") {
      setStatus(`Thanks — "${codeObj.code}" marked as working.`, true);
    } else {
      setStatus("Vote cleared.");
    }
    updateBadgeCount();
  }

  function updateBadgeCount() {
    if (state.badge) state.badge.textContent = String(visibleCodes().length);
  }

  function buildCodeItem(codeObj) {
    const item = document.createElement("div");
    item.className = "ukcp-item";
    const vote = getVote(state.domain, codeObj.code);
    if (vote === "down") item.classList.add("ukcp-voted-down");

    const value = discountLabel(codeObj);
    const seen = daysAgo(codeObj.lastSeen);
    const tags = [];
    if (value) tags.push(`<span class="ukcp-tag ukcp-value">${escapeHtml(value)}</span>`);
    if (codeObj.minSpend != null) tags.push(`<span class="ukcp-tag">min £${escapeHtml(codeObj.minSpend)}</span>`);
    if (seen) {
      // A code no source has listed for weeks is probably gone, even though
      // nobody has reported it yet — say so rather than ranking it silently.
      const stale = isStale(codeObj);
      tags.push(`<span class="ukcp-tag${stale ? " ukcp-stale" : ""}">seen ${escapeHtml(seen)}</span>`);
    }
    if (codeObj.expiry) {
      const past = isExpired(codeObj);
      tags.push(
        `<span class="ukcp-tag${past ? " ukcp-expired" : ""}" title="${past ? "Past its end date — often still works, worth a try" : ""}">` +
        `${past ? "expired" : "expires"} ${escapeHtml(codeObj.expiry)}</span>`
      );
    }
    if (codeObj.sources?.length > 1) tags.push(`<span class="ukcp-tag">${codeObj.sources.length} sources</span>`);

    item.innerHTML = `
      <div class="ukcp-item-main" role="button" tabindex="0">
        <div class="ukcp-code">${escapeHtml(codeObj.code)}</div>
        ${codeObj.description ? `<div class="ukcp-desc" title="${escapeHtml(codeObj.description)}">${escapeHtml(codeObj.description)}</div>` : ""}
        ${tags.length ? `<div class="ukcp-tags">${tags.join("")}</div>` : ""}
      </div>
      <div class="ukcp-votes">
        <button class="ukcp-vote${vote === "up" ? " ukcp-active" : ""}" data-vote="up" title="This worked">👍</button>
        <button class="ukcp-vote${vote === "down" ? " ukcp-active" : ""}" data-vote="down" title="Didn't work — hide it">👎</button>
      </div>
    `;

    const main = item.querySelector(".ukcp-item-main");
    main.addEventListener("click", () => useCode(codeObj));
    main.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        useCode(codeObj);
      }
    });
    for (const btn of item.querySelectorAll(".ukcp-vote")) {
      btn.addEventListener("click", () => handleVote(codeObj, btn.dataset.vote));
    }
    return item;
  }

  function renderList() {
    const list = state.panel.querySelector(".ukcp-list");
    list.innerHTML = "";
    const codes = state.codes;
    if (codes.length === 0) {
      list.innerHTML = `<div class="ukcp-empty">No codes for this store.</div>`;
      return;
    }
    for (const c of codes) list.appendChild(buildCodeItem(c));
  }

  function buildUI() {
    const badge = document.createElement("button");
    badge.id = "ukcp-badge";
    badge.title = `Coupon codes for ${state.storeName}`;
    badge.textContent = String(visibleCodes().length);
    badge.addEventListener("click", () => togglePanel());

    const panel = document.createElement("div");
    panel.id = "ukcp-panel";
    panel.innerHTML = `
      <div class="ukcp-head">
        <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(state.domain)}&sz=32" alt="" onerror="this.style.display='none'">
        <div class="ukcp-head-text">
          <h3>${escapeHtml(state.storeName)}</h3>
          <div class="ukcp-head-sub">${state.codes.length} code${state.codes.length === 1 ? "" : "s"}</div>
        </div>
        <button class="ukcp-icon-btn ukcp-refresh" title="Refresh from GitHub">↻</button>
        <button class="ukcp-icon-btn ukcp-close" title="Close">✕</button>
      </div>
      <div class="ukcp-status"></div>
      <div class="ukcp-list"></div>
      <div class="ukcp-foot">
        <span class="ukcp-report-slot"></span>
        <button class="ukcp-link ukcp-hide-site">Hide on ${escapeHtml(currentHost())}</button>
      </div>
    `;

    panel.querySelector(".ukcp-close").addEventListener("click", () => togglePanel(false));
    panel.querySelector(".ukcp-hide-site").addEventListener("click", () => {
      setSiteHidden(currentHost(), true);
      panel.remove();
      badge.remove();
    });
    panel.querySelector(".ukcp-refresh").addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.textContent = "⏳";
      try {
        const fresh = await fetchStore(state.domain, true);
        state.codes = sortCodes(fresh.codes || []);
        state.storeName = fresh.name || state.storeName;
        renderList();
        updateBadgeCount();
        panel.querySelector(".ukcp-head-sub").textContent =
          `${state.codes.length} code${state.codes.length === 1 ? "" : "s"}`;
        setStatus("Refreshed.", true);
      } catch (err) {
        setStatus(`Refresh failed: ${err.message}`);
      }
      btn.textContent = "↻";
    });

    document.body.appendChild(badge);
    document.body.appendChild(panel);
    state.badge = badge;
    state.panel = panel;

    renderList();
    refreshStatusForPage();
  }

  // ─── ENTRY POINT ─────────────────────────────────────────────────────────
  async function main() {
    if (!location.protocol.startsWith("http")) return;

    const host = currentHost();
    if (isSiteHidden(host)) {
      log(`hidden on ${host} — use Tampermonkey storage to undo`);
      return;
    }

    let index;
    try {
      index = await fetchIndex(false);
    } catch (err) {
      log("could not load index:", err.message);
      return;
    }

    // Resolve against the index first — only then is a store file worth
    // fetching, so unsupported sites cost one small cached request and stop.
    const domain = resolveDomain(host, index?.stores || {}, index?.aliases || {});
    if (!domain) return; // No UI, no styles, nothing injected.

    let store;
    try {
      store = await fetchStore(domain, false);
    } catch (err) {
      log(`could not load store ${domain}:`, err.message);
      return;
    }

    // state.domain first: sortCodes reads your saved votes, which are keyed by
    // domain, so sorting before this would rank everything as unvoted.
    state.domain = domain;
    state.storeName = store.name || domain;

    const codes = sortCodes(store.codes || []);
    if (codes.length === 0) return;
    state.codes = codes;

    injectStyles();
    buildUI();
    log(`${codes.length} codes for ${state.storeName} (${domain})`);
  }

  main();
})();
