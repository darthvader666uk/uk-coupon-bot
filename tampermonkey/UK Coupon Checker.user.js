// ==UserScript==
// @name         UK Coupon Checker
// @namespace    https://github.com/darthvader666uk/uk-coupon-bot
// @version      1.2
// @description  Shows available UK coupon codes for the current store with Coupert-style proactive notifications, auto-try at checkout and savings tracking.
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
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
  const PANEL_KEY = "uk-coupon-panel";
  const POS_KEY = "uk-coupon-panel-pos";
  const FAILED_KEY = "uk-coupon-failed";
  const SAVINGS_TOTAL_KEY = "uk-coupon-savings-total";
  const SAVINGS_ORDERS_KEY = "uk-coupon-savings-orders";

  // ─── STYLES ──────────────────────────────────────────────────────────────
  GM_addStyle(`
    :root {
      --ukcp-bg: #1a1a2e;
      --ukcp-panel: #16213e;
      --ukcp-accent: #e94560;
      --ukcp-accent-hover: #c73652;
      --ukcp-text: #eeeeee;
      --ukcp-muted: #888888;
      --ukcp-border: #333333;
      --ukcp-green: #4caf50;
      --ukcp-yellow: #ff9800;
      --ukcp-red: #f44336;
      --ukcp-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
      --ukcp-radius: 16px;
      --ukcp-radius-sm: 10px;
      --ukcp-space: 8px;
    }

    .ukcp-hidden { display: none !important; }

    /* ── Badge ── */
    #uk-coupon-badge {
      position: fixed;
      top: 50%;
      right: 20px;
      transform: translateY(-50%);
      z-index: 999999;
      width: 60px;
      height: 60px;
      border-radius: var(--ukcp-radius);
      background: var(--ukcp-bg);
      border: 2px solid var(--ukcp-accent);
      box-shadow: 0 6px 22px rgba(233, 69, 96, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      transition: transform 0.2s ease, box-shadow 0.2s ease;
      user-select: none;
      overflow: visible;
    }
    #uk-coupon-badge:hover {
      transform: scale(1.08);
      box-shadow: 0 10px 30px rgba(233, 69, 96, 0.65);
    }
    #uk-coupon-badge.ukcp-pulse {
      animation: ukcpPulse 2s infinite;
    }
    @keyframes ukcpPulse {
      0% { box-shadow: 0 0 0 0 rgba(233, 69, 96, 0.55); }
      70% { box-shadow: 0 0 0 14px rgba(233, 69, 96, 0); }
      100% { box-shadow: 0 0 0 0 rgba(233, 69, 96, 0); }
    }
    #uk-coupon-badge .ukcp-badge-logo {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      object-fit: contain;
      background: #fff;
      padding: 2px;
    }
    #uk-coupon-badge .ukcp-badge-count {
      position: absolute;
      top: -6px;
      right: -6px;
      min-width: 20px;
      height: 20px;
      padding: 0 5px;
      border-radius: 10px;
      background: var(--ukcp-accent);
      color: #fff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid var(--ukcp-bg);
    }
    #uk-coupon-badge.no-codes {
      border-color: #444;
      box-shadow: 0 4px 12px rgba(0,0,0,0.35);
      cursor: default;
      animation: none;
    }
    #uk-coupon-badge.no-codes .ukcp-badge-count { display: none; }

    /* ── Toast ── */
    #uk-coupon-toast {
      position: fixed;
      bottom: 92px;
      right: 20px;
      z-index: 999998;
      width: 360px;
      max-width: calc(100vw - 40px);
      background: var(--ukcp-bg);
      color: var(--ukcp-text);
      border: 1px solid var(--ukcp-border);
      border-left: 4px solid var(--ukcp-accent);
      border-radius: var(--ukcp-radius);
      box-shadow: var(--ukcp-shadow);
      padding: 14px 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      display: flex;
      align-items: center;
      gap: 12px;
      transform: translateX(130%);
      opacity: 0;
      transition: transform 0.55s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s ease;
      pointer-events: auto;
    }
    #uk-coupon-toast.ukcp-show {
      transform: translateX(0);
      opacity: 1;
    }
    #uk-coupon-toast .ukcp-toast-logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: #fff;
      padding: 3px;
      flex-shrink: 0;
      object-fit: contain;
    }
    #uk-coupon-toast .ukcp-toast-body {
      flex: 1;
      line-height: 1.35;
    }
    #uk-coupon-toast .ukcp-toast-title {
      font-weight: 700;
      color: #fff;
      margin-bottom: 2px;
    }
    #uk-coupon-toast .ukcp-toast-store {
      color: var(--ukcp-accent);
      font-weight: 700;
    }
    #uk-coupon-toast .ukcp-toast-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
    }
    #uk-coupon-toast .ukcp-toast-btn {
      background: var(--ukcp-accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    #uk-coupon-toast .ukcp-toast-btn:hover { background: var(--ukcp-accent-hover); }
    #uk-coupon-toast .ukcp-toast-close {
      color: var(--ukcp-muted);
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
      padding: 4px;
      margin: -4px;
    }
    #uk-coupon-toast .ukcp-toast-close:hover { color: #fff; }

    /* ── Panel ── */
    #uk-coupon-panel {
      position: fixed;
      bottom: 92px;
      right: 20px;
      z-index: 999997;
      width: 400px;
      max-width: calc(100vw - 40px);
      max-height: 560px;
      background: var(--ukcp-bg);
      color: var(--ukcp-text);
      border: 1px solid var(--ukcp-border);
      border-radius: var(--ukcp-radius);
      box-shadow: var(--ukcp-shadow);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      display: none;
      overflow: hidden;
      flex-direction: column;
    }
    #uk-coupon-panel.open { display: flex; }

    .ukcp-header {
      padding: calc(var(--ukcp-space) * 2);
      background: var(--ukcp-panel);
      border-bottom: 1px solid var(--ukcp-border);
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .ukcp-header .ukcp-store-logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: #fff;
      padding: 3px;
      object-fit: contain;
      flex-shrink: 0;
    }
    .ukcp-header .ukcp-title-block { flex: 1; min-width: 0; }
    .ukcp-header h3 {
      margin: 0;
      font-size: 15px;
      color: #fff;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ukcp-header .ukcp-subtitle {
      font-size: 11px;
      color: var(--ukcp-muted);
      margin-top: 2px;
    }
    .ukcp-header .ukcp-header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-shrink: 0;
    }
    .ukcp-header .ukcp-refresh,
    .ukcp-header .ukcp-close {
      cursor: pointer;
      color: var(--ukcp-muted);
      font-size: 16px;
      line-height: 1;
      transition: color 0.15s;
    }
    .ukcp-header .ukcp-refresh:hover { color: var(--ukcp-green); }
    .ukcp-header .ukcp-close:hover { color: #fff; }

    .ukcp-meta {
      padding: calc(var(--ukcp-space) * 1.5) calc(var(--ukcp-space) * 2);
      background: rgba(22, 33, 62, 0.5);
      border-bottom: 1px solid var(--ukcp-border);
      font-size: 12px;
      color: var(--ukcp-muted);
    }
    .ukcp-meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 6px;
    }
    .ukcp-meta-row:last-child { margin-bottom: 0; }
    .ukcp-savings-pill {
      background: rgba(76, 175, 80, 0.15);
      color: var(--ukcp-green);
      border: 1px solid rgba(76, 175, 80, 0.35);
      border-radius: 20px;
      padding: 3px 10px;
      font-size: 11px;
      font-weight: 700;
    }
    .ukcp-success-rate-bar {
      height: 6px;
      background: #2a2a45;
      border-radius: 3px;
      overflow: hidden;
      margin-top: 6px;
    }
    .ukcp-success-rate-fill {
      height: 100%;
      border-radius: 3px;
      transition: width 0.6s ease;
    }
    .ukcp-rate-green { background: var(--ukcp-green); }
    .ukcp-rate-yellow { background: var(--ukcp-yellow); }
    .ukcp-rate-red { background: var(--ukcp-red); }

    .ukcp-panel-actions {
      padding: calc(var(--ukcp-space) * 1.5) calc(var(--ukcp-space) * 2);
      border-bottom: 1px solid var(--ukcp-border);
      display: flex;
      gap: 8px;
    }
    .ukcp-action-btn {
      flex: 1;
      background: var(--ukcp-accent);
      color: #fff;
      border: none;
      border-radius: var(--ukcp-radius-sm);
      padding: 9px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s, transform 0.1s;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .ukcp-action-btn:hover { background: var(--ukcp-accent-hover); }
    .ukcp-action-btn:active { transform: scale(0.98); }
    .ukcp-action-btn.secondary {
      background: transparent;
      border: 1px solid var(--ukcp-border);
      color: var(--ukcp-text);
    }
    .ukcp-action-btn.secondary:hover { border-color: var(--ukcp-accent); color: var(--ukcp-accent); }
    .ukcp-action-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .ukcp-codes {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
    }
    .ukcp-codes::-webkit-scrollbar { width: 6px; }
    .ukcp-codes::-webkit-scrollbar-track { background: var(--ukcp-bg); }
    .ukcp-codes::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }

    .ukcp-code-item {
      padding: 12px 16px;
      border-bottom: 1px solid #222;
      cursor: pointer;
      transition: background 0.15s;
    }
    .ukcp-code-item:hover { background: var(--ukcp-panel); }
    .ukcp-code-item:last-child { border-bottom: none; }

    .ukcp-code-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 10px;
    }
    .ukcp-code-text {
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 15px;
      font-weight: 800;
      color: var(--ukcp-accent);
      letter-spacing: 1px;
    }
    .ukcp-code-rate {
      font-size: 11px;
      font-weight: 700;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ukcp-code-rate.ukcp-rate-green { color: var(--ukcp-green); }
    .ukcp-code-rate.ukcp-rate-yellow { color: var(--ukcp-yellow); }
    .ukcp-code-rate.ukcp-rate-red { color: var(--ukcp-red); }
    .ukcp-code-desc {
      font-size: 12px;
      color: #aaa;
      margin-top: 4px;
      line-height: 1.45;
    }
    .ukcp-code-meta {
      font-size: 10px;
      color: #666;
      margin-top: 8px;
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .ukcp-code-meta span { display: inline-flex; align-items: center; gap: 3px; }
    .ukcp-mini-bar {
      width: 50px;
      height: 4px;
      background: #2a2a45;
      border-radius: 2px;
      overflow: hidden;
      display: inline-block;
      vertical-align: middle;
      margin-right: 4px;
    }
    .ukcp-mini-bar-fill {
      height: 100%;
      border-radius: 2px;
    }

    .ukcp-source-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .ukcp-source-hotukdeals { background: #ff6600; color: #fff; }
    .ukcp-source-vouchercodes { background: #00a651; color: #fff; }
    .ukcp-source-ggdeals { background: #7b68ee; color: #fff; }
    .ukcp-source-myvouchercodes { background: #e91e63; color: #fff; }
    .ukcp-source-savoo { background: #2196f3; color: #fff; }
    .ukcp-source-coupert { background: #ff5722; color: #fff; }
    .ukcp-source-honey { background: #ffb300; color: #000; }
    .ukcp-source-netvouchercodes { background: #9c27b0; color: #fff; }
    .ukcp-source-unknown { background: #666; color: #fff; }

    .ukcp-code-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
    }
    .ukcp-copy-btn {
      background: var(--ukcp-accent);
      color: #fff;
      border: none;
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
    }
    .ukcp-copy-btn:hover { background: var(--ukcp-accent-hover); }
    .ukcp-fail-btn {
      background: transparent;
      color: #666;
      border: 1px solid #444;
      padding: 5px 10px;
      border-radius: 6px;
      font-size: 10px;
      cursor: pointer;
      transition: color 0.15s, border-color 0.15s;
    }
    .ukcp-fail-btn:hover { color: var(--ukcp-accent); border-color: var(--ukcp-accent); }

    .ukcp-empty {
      padding: 34px 16px;
      text-align: center;
      color: #555;
    }

    /* ── Checkout Floater ── */
    #uk-coupon-checkout {
      position: fixed;
      z-index: 999996;
      width: 320px;
      max-width: calc(100vw - 40px);
      background: var(--ukcp-bg);
      color: var(--ukcp-text);
      border: 1px solid var(--ukcp-border);
      border-left: 4px solid var(--ukcp-accent);
      border-radius: var(--ukcp-radius);
      box-shadow: var(--ukcp-shadow);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      padding: 16px;
      display: none;
    }
    #uk-coupon-checkout.ukcp-show { display: block; }

    #uk-coupon-checkout .ukcp-checkout-head {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    #uk-coupon-checkout .ukcp-checkout-logo {
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: #fff;
      padding: 2px;
      object-fit: contain;
      flex-shrink: 0;
    }
    #uk-coupon-checkout h4 {
      margin: 0;
      font-size: 14px;
      color: #fff;
      flex: 1;
    }
    #uk-coupon-checkout .ukcp-checkout-close {
      color: var(--ukcp-muted);
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 4px;
      margin: -4px;
      transition: color 0.15s;
    }
    #uk-coupon-checkout .ukcp-checkout-close:hover { color: #fff; }

    #uk-coupon-checkout .ukcp-checkout-status {
      font-size: 12px;
      font-weight: 500;
      padding: 6px 10px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      margin-bottom: 12px;
      min-height: 18px;
      transition: color 0.2s, background 0.2s;
    }
    #uk-coupon-checkout .ukcp-checkout-status.ukcp-working { color: var(--ukcp-yellow); background: rgba(255, 152, 0, 0.1); }
    #uk-coupon-checkout .ukcp-checkout-status.ukcp-success { color: var(--ukcp-green); background: rgba(76, 175, 80, 0.1); }
    #uk-coupon-checkout .ukcp-checkout-status.ukcp-fail { color: var(--ukcp-red); background: rgba(244, 67, 54, 0.1); }

    #uk-coupon-checkout .ukcp-checkout-progress {
      display: none;
      align-items: center;
      gap: 10px;
      margin: 12px 0;
    }
    #uk-coupon-checkout .ukcp-checkout-progress.ukcp-active { display: flex; }
    #uk-coupon-checkout .ukcp-progress-bar {
      flex: 1;
      height: 8px;
      background: #2a2a45;
      border-radius: 4px;
      overflow: hidden;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
    }
    #uk-coupon-checkout .ukcp-progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--ukcp-accent), var(--ukcp-accent-hover));
      border-radius: 4px;
      transition: width 0.4s cubic-bezier(0.22, 1, 0.36, 1);
    }
    #uk-coupon-checkout .ukcp-progress-text {
      font-size: 11px;
      font-weight: 700;
      color: var(--ukcp-muted);
      min-width: 44px;
      text-align: right;
    }

    #uk-coupon-checkout .ukcp-checkout-list {
      max-height: 240px;
      overflow-y: auto;
      margin-top: 8px;
      padding: 4px 0;
    }
    #uk-coupon-checkout .ukcp-checkout-list::-webkit-scrollbar { width: 6px; }
    #uk-coupon-checkout .ukcp-checkout-list::-webkit-scrollbar-track { background: transparent; }
    #uk-coupon-checkout .ukcp-checkout-list::-webkit-scrollbar-thumb { background: #444; border-radius: 3px; }
    #uk-coupon-checkout .ukcp-checkout-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 12px;
      border-bottom: 1px solid #2a2a45;
      border-radius: 6px;
      transition: background 0.15s;
    }
    #uk-coupon-checkout .ukcp-checkout-item:hover { background: rgba(255, 255, 255, 0.04); }
    #uk-coupon-checkout .ukcp-checkout-item:last-child { border-bottom: none; }
    #uk-coupon-checkout .ukcp-checkout-item.ukcp-tried {
      opacity: 0.5;
      position: relative;
    }
    #uk-coupon-checkout .ukcp-checkout-item.ukcp-tried::after {
      content: "✓";
      position: absolute;
      right: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--ukcp-green);
      font-weight: 700;
      font-size: 16px;
    }
    #uk-coupon-checkout .ukcp-checkout-item.ukcp-failed::after {
      content: "✗";
      color: var(--ukcp-red);
    }
    #uk-coupon-checkout .ukcp-checkout-code {
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 14px;
      font-weight: 700;
      color: var(--ukcp-accent);
      letter-spacing: 0.5px;
    }
    #uk-coupon-checkout .ukcp-checkout-rate {
      font-size: 10px;
      color: var(--ukcp-muted);
      margin-top: 2px;
    }
    #uk-coupon-checkout .ukcp-checkout-try {
      background: var(--ukcp-accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 7px 14px;
      font-size: 12px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      cursor: pointer;
      flex-shrink: 0;
      box-shadow: 0 3px 8px rgba(233, 69, 96, 0.35);
      transition: background 0.15s, transform 0.1s, box-shadow 0.15s;
    }
    #uk-coupon-checkout .ukcp-checkout-try:hover {
      background: var(--ukcp-accent-hover);
      box-shadow: 0 5px 12px rgba(233, 69, 96, 0.5);
    }
    #uk-coupon-checkout .ukcp-checkout-try:active { transform: scale(0.96); }
    #uk-coupon-checkout .ukcp-checkout-try:disabled {
      opacity: 0.5;
      cursor: not-allowed;
      box-shadow: none;
    }

    /* ── Savings prompt / modal ── */
    #uk-coupon-modal-overlay {
      position: fixed;
      inset: 0;
      z-index: 1000000;
      background: rgba(0, 0, 0, 0.65);
      display: none;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
    #uk-coupon-modal-overlay.ukcp-show { display: flex; }
    .ukcp-modal {
      width: 340px;
      max-width: calc(100vw - 40px);
      background: var(--ukcp-bg);
      color: var(--ukcp-text);
      border: 1px solid var(--ukcp-border);
      border-radius: var(--ukcp-radius);
      box-shadow: var(--ukcp-shadow);
      padding: 22px;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .ukcp-modal h3 {
      margin: 0 0 8px;
      font-size: 18px;
      color: #fff;
    }
    .ukcp-modal p {
      margin: 0 0 16px;
      font-size: 13px;
      color: #aaa;
      line-height: 1.45;
    }
    .ukcp-modal input {
      width: 100%;
      box-sizing: border-box;
      background: var(--ukcp-panel);
      border: 1px solid var(--ukcp-border);
      border-radius: var(--ukcp-radius-sm);
      color: #fff;
      padding: 10px 12px;
      font-size: 14px;
      margin-bottom: 14px;
      outline: none;
    }
    .ukcp-modal input:focus { border-color: var(--ukcp-accent); }
    .ukcp-modal-actions {
      display: flex;
      gap: 10px;
    }
    .ukcp-modal-actions button {
      flex: 1;
      border: none;
      border-radius: var(--ukcp-radius-sm);
      padding: 10px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: opacity 0.15s;
    }
    .ukcp-modal-actions button:hover { opacity: 0.9; }
    .ukcp-modal-actions .ukcp-primary { background: var(--ukcp-accent); color: #fff; }
    .ukcp-modal-actions .ukcp-secondary { background: transparent; border: 1px solid var(--ukcp-border); color: var(--ukcp-text); }

    /* ── Copied toast ── */
    .ukcp-copied {
      position: fixed;
      bottom: 92px;
      right: 20px;
      z-index: 1000001;
      background: var(--ukcp-panel);
      color: var(--ukcp-green);
      border: 1px solid var(--ukcp-green);
      border-radius: var(--ukcp-radius-sm);
      padding: 10px 16px;
      font-family: -apple-system, sans-serif;
      font-size: 13px;
      animation: ukcpFade 2.2s forwards;
    }
    @keyframes ukcpFade {
      0%, 75% { opacity: 1; }
      100% { opacity: 0; pointer-events: none; }
    }

    /* ── Results summary list ── */
    .ukcp-results-list {
      max-height: 300px;
      overflow-y: auto;
      margin: 12px 0;
    }
    .ukcp-result-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      border-bottom: 1px solid #222;
    }
    .ukcp-result-item:last-child { border-bottom: none; }
    .ukcp-result-code {
      font-family: "SF Mono", "Fira Code", Consolas, monospace;
      font-size: 13px;
      font-weight: 700;
      color: var(--ukcp-accent);
    }
    .ukcp-result-mark {
      background: var(--ukcp-green);
      color: #fff;
      border: none;
      border-radius: 5px;
      padding: 5px 10px;
      font-size: 11px;
      font-weight: 700;
      cursor: pointer;
    }
    .ukcp-result-mark:hover { opacity: 0.9; }
    .ukcp-result-status {
      font-size: 16px;
      margin: 0 8px;
    }
  `);

  // ─── HELPERS ───────────────────────────────────────────────────────────────
  function getCurrentDomain() {
    return window.location.hostname.toLowerCase().replace(/^www\./, "");
  }

  function getStoreLogoUrl(domain) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function daysAgo(dateString) {
    if (!dateString) return null;
    const d = new Date(dateString);
    if (isNaN(d.getTime())) return null;
    const diff = Date.now() - d.getTime();
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days < 1) return "today";
    if (days === 1) return "1 day ago";
    return `${days} days ago`;
  }

  function getCodeSuccess(code) {
    const worked = code.testResults?.worked || 0;
    const total = code.testResults?.total || 0;
    if (total === 0) return null;
    return Math.round((worked / total) * 100);
  }

  function getRateClass(rate) {
    if (rate === null || rate === undefined) return "";
    if (rate >= 70) return "ukcp-rate-green";
    if (rate >= 40) return "ukcp-rate-yellow";
    return "ukcp-rate-red";
  }

  function sortCodesBySuccess(codes) {
    return [...codes].sort((a, b) => {
      const rateA = getCodeSuccess(a) ?? -1;
      const rateB = getCodeSuccess(b) ?? -1;
      if (rateB !== rateA) return rateB - rateA;
      const seenA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
      const seenB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
      return seenB - seenA;
    });
  }

  // ─── HOSTNAME MATCHING ───────────────────────────────────────────────────
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

    if (stores[domain]) {
      console.log("[UK Coupon Checker] Direct match found:", domain);
      return stores[domain];
    }

    const variations = [domain, domain.replace(/^www\./, ""), "www." + domain];
    for (const v of variations) {
      if (stores[v]) {
        console.log("[UK Coupon Checker] Variation match found:", v);
        return stores[v];
      }
    }

    if (stores[domain + ".co.uk"]) {
      console.log("[UK Coupon Checker] .co.uk match found:", domain + ".co.uk");
      return stores[domain + ".co.uk"];
    }

    for (const [key, store] of Object.entries(stores)) {
      const keyBase = key.replace(/\.co\.uk$/, "").replace(/\./g, "");
      const domainClean = domain.replace(/\./g, "");
      if (domain.includes(keyBase) || keyBase.includes(domainClean) || domainClean.includes(keyBase)) {
        console.log("[UK Coupon Checker] Partial match found:", key);
        return store;
      }
    }

    console.log("[UK Coupon Checker] Checking gaming domains…");
    for (const gamingDomain of GAMING_DOMAINS) {
      if (domain.includes(gamingDomain) || gamingDomain.includes(domain)) {
        console.log("[UK Coupon Checker] Gaming domain matched:", gamingDomain);
        const storeKey = Object.keys(stores).find(k =>
          k === gamingDomain || gamingDomain.includes(k.replace(/^www\./, ""))
        );
        if (storeKey && stores[storeKey] && stores[storeKey].codes?.length > 0) {
          console.log("[UK Coupon Checker] Store-specific match:", storeKey, stores[storeKey].codes.length, "codes");
          return stores[storeKey];
        }

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

  function findApplyButton(input) {
    const candidateSelectors = [
      'button[type="submit"]',
      'button',
      'input[type="submit"]',
      'a',
    ];
    const labels = ["apply", "redeem", "use", "submit"];
    // Search within a small radius first
    const parent = input.closest("form, div, section") || document.body;
    for (const sel of candidateSelectors) {
      const els = Array.from(parent.querySelectorAll(sel));
      for (const el of els) {
        const text = (el.textContent || el.value || "").toLowerCase();
        if (labels.some(l => text.includes(l))) return el;
      }
    }
    return null;
  }

  function applyCodeToInput(input, code) {
    if (!input) return false;
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    nativeInputValueSetter.call(input, code);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
    return true;
  }

  function autoFillCode(code) {
    const input = findCheckoutInput();
    if (input) {
      applyCodeToInput(input, code);
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

  // ─── FAILED CODES ─────────────────────────────────────────────────────────
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

  // ─── REPORT FAILED ────────────────────────────────────────────────────────
  function reportFailed(code, storeDomain) {
    const reason = prompt(`Report "${code}" as failed at ${storeDomain}.\nOptional — describe what happened:`);
    if (reason === null) return;

    markCodeFailed(code, storeDomain);
    GM_notification({ title: "UK Coupon Checker", text: "Thanks — code marked as not working", timeout: 3000 });
  }

  // ─── SAVINGS TRACKING ─────────────────────────────────────────────────────
  function getSavings() {
    const total = parseFloat(GM_getValue(SAVINGS_TOTAL_KEY, "0")) || 0;
    const orders = parseInt(GM_getValue(SAVINGS_ORDERS_KEY, "0")) || 0;
    return { total, orders };
  }

  function recordSaving(amount) {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) return false;
    const current = getSavings();
    GM_setValue(SAVINGS_TOTAL_KEY, (current.total + parsed).toFixed(2));
    GM_setValue(SAVINGS_ORDERS_KEY, current.orders + 1);
    return true;
  }

  function formatMoney(amount) {
    return "£" + parseFloat(amount).toFixed(2);
  }

  function showSavingsPrompt(code, onComplete) {
    const overlay = document.getElementById("uk-coupon-modal-overlay") || createModalOverlay();
    overlay.innerHTML = "";

    const modal = document.createElement("div");
    modal.className = "ukcp-modal";
    modal.innerHTML = `
      <h3>🎉 Code applied!</h3>
      <p>"${escapeHtml(code)}" was entered. How much did you save?</p>
      <input type="number" step="0.01" min="0" placeholder="e.g. 12.50" id="ukcp-savings-input">
      <div class="ukcp-modal-actions">
        <button class="ukcp-secondary" id="ukcp-savings-skip">Skip</button>
        <button class="ukcp-primary" id="ukcp-savings-save">Save £</button>
      </div>
    `;
    overlay.appendChild(modal);
    overlay.classList.add("ukcp-show");

    const input = modal.querySelector("#ukcp-savings-input");
    input.focus();

    modal.querySelector("#ukcp-savings-skip").addEventListener("click", () => {
      overlay.classList.remove("ukcp-show");
      if (typeof onComplete === "function") onComplete(0, false);
    });

    function save() {
      const val = input.value.trim();
      if (val && recordSaving(val)) {
        overlay.classList.remove("ukcp-show");
        GM_notification({ title: "UK Coupon Checker", text: `You saved ${formatMoney(val)}!`, timeout: 4000 });
        refreshSavingsDisplay();
        if (typeof onComplete === "function") onComplete(parseFloat(val), true);
      } else {
        input.style.borderColor = "var(--ukcp-red)";
      }
    }

    modal.querySelector("#ukcp-savings-save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save();
    });
  }

  function createModalOverlay() {
    const overlay = document.createElement("div");
    overlay.id = "uk-coupon-modal-overlay";
    document.body.appendChild(overlay);
    return overlay;
  }

  function refreshSavingsDisplay() {
    const pill = document.querySelector(".ukcp-savings-pill");
    if (pill) {
      const { total, orders } = getSavings();
      if (orders > 0) {
        pill.textContent = `You've saved ${formatMoney(total)} across ${orders} order${orders === 1 ? "" : "s"}`;
        pill.classList.remove("ukcp-hidden");
      } else {
        pill.classList.add("ukcp-hidden");
      }
    }
  }

  // ─── NOTIFICATION TOAST ───────────────────────────────────────────────────
  function showNotificationToast(codes, storeData, domain) {
    if (!codes || codes.length === 0) return;
    if (document.getElementById("uk-coupon-toast")) return;

    const toast = document.createElement("div");
    toast.id = "uk-coupon-toast";
    toast.innerHTML = `
      <img class="ukcp-toast-logo" src="${getStoreLogoUrl(domain)}" alt="" onerror="this.style.display='none'">
      <div class="ukcp-toast-body">
        <div class="ukcp-toast-title">🎟 ${codes.length} coupon${codes.length === 1 ? "" : "s"} available</div>
        <div>for <span class="ukcp-toast-store">${escapeHtml(storeData.name || domain)}</span></div>
        <div class="ukcp-toast-actions">
          <button class="ukcp-toast-btn">View codes</button>
        </div>
      </div>
      <span class="ukcp-toast-close">✕</span>
    `;

    toast.querySelector(".ukcp-toast-btn").addEventListener("click", () => {
      dismissToast();
      openPanel();
    });
    toast.querySelector(".ukcp-toast-close").addEventListener("click", dismissToast);
    toast.addEventListener("click", (e) => {
      if (e.target === toast) dismissToast();
    });

    document.body.appendChild(toast);

    // Slide in
    requestAnimationFrame(() => toast.classList.add("ukcp-show"));

    // Auto dismiss
    const autoDismiss = setTimeout(dismissToast, 8000);

    function dismissToast() {
      clearTimeout(autoDismiss);
      toast.classList.remove("ukcp-show");
      setTimeout(() => toast.remove(), 400);
    }
  }

  // ─── BADGE ────────────────────────────────────────────────────────────────
  function buildBadge(codes, storeData, domain) {
    let badge = document.getElementById("uk-coupon-badge");
    if (!badge) {
      badge = document.createElement("div");
      badge.id = "uk-coupon-badge";
      badge.title = `${codes.length} code${codes.length === 1 ? "" : "s"} available for ${storeData.name || domain}`;
      badge.addEventListener("click", () => {
        if (codes.length > 0) togglePanel();
      });
      document.body.appendChild(badge);
    }

    badge.className = codes.length > 0 ? "ukcp-pulse" : "no-codes";
    badge.innerHTML = `
      <img class="ukcp-badge-logo" src="${getStoreLogoUrl(domain)}" alt="" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex'">
      <span class="ukcp-badge-count" style="display:none">${codes.length}</span>
    `;

    // If logo fails, fallback count is revealed via inline handler above, but also ensure count shows if no logo src
    const logo = badge.querySelector(".ukcp-badge-logo");
    logo.addEventListener("error", () => {
      logo.style.display = "none";
      badge.querySelector(".ukcp-badge-count").style.display = "flex";
    });
  }

  // ─── PANEL ────────────────────────────────────────────────────────────────
  function openPanel() {
    const panel = document.getElementById("uk-coupon-panel");
    if (panel) panel.classList.add("open");
  }

  function togglePanel() {
    const panel = document.getElementById("uk-coupon-panel");
    if (panel) panel.classList.toggle("open");
  }

  function buildPanel(codes, storeData, domain) {
    // Clean up previous UI
    document.getElementById("uk-coupon-panel")?.remove();
    document.getElementById("uk-coupon-badge")?.remove();
    document.getElementById("uk-coupon-toast")?.remove();

    if (!codes || codes.length === 0) return;

    const visibleCodes = codes.filter(c => !isCodeFailed(c.code, domain));
    const logoUrl = getStoreLogoUrl(domain);
    const { total, orders } = getSavings();

    // Badge
    buildBadge(visibleCodes, storeData, domain);

    // Notification toast — disabled; badge is sufficient
    // showNotificationToast(visibleCodes, storeData, domain);

    // Panel
    const panel = document.createElement("div");
    panel.id = "uk-coupon-panel";

    const savedPos = GM_getValue(POS_KEY);
    if (savedPos) {
      panel.style.bottom = savedPos.bottom || "92px";
      panel.style.right = savedPos.right || "20px";
    }

    // Header
    const header = document.createElement("div");
    header.className = "ukcp-header";
    header.innerHTML = `
      <img class="ukcp-store-logo" src="${logoUrl}" alt="" onerror="this.style.display='none'">
      <div class="ukcp-title-block">
        <h3>${escapeHtml(storeData.name || domain)}</h3>
        <div class="ukcp-subtitle">${visibleCodes.length} coupon${visibleCodes.length === 1 ? "" : "s"} found</div>
      </div>
      <div class="ukcp-header-actions">
        <span class="ukcp-refresh" title="Refresh codes from server">↻</span>
        <span class="ukcp-close" title="Close">✕</span>
      </div>
    `;

    header.querySelector(".ukcp-refresh").addEventListener("click", async (e) => {
      const btn = e.target;
      btn.textContent = "⏳";
      GM_setValue("coupon_cache", null);
      GM_setValue("coupon_cache_time", 0);
      try {
        const fresh = await fetchDatabase();
        const newDomain = getCurrentDomain();
        const newStore = matchStore(newDomain, fresh.stores);
        if (newStore && newStore.codes?.length > 0) {
          const sorted = sortCodesBySuccess(newStore.codes);
          buildPanel(sorted, newStore, newDomain);
          buildCheckoutFloater(sorted, newStore, newDomain);
        } else {
          document.getElementById("uk-coupon-panel")?.remove();
          document.getElementById("uk-coupon-badge")?.remove();
          document.getElementById("uk-coupon-toast")?.remove();
        }
      } catch (err) {
        btn.textContent = "✗";
        setTimeout(() => { btn.textContent = "↻"; }, 1500);
      }
    });
    header.querySelector(".ukcp-close").addEventListener("click", togglePanel);
    panel.appendChild(header);

    // Meta
    const meta = document.createElement("div");
    meta.className = "ukcp-meta";

    const lastSeenRaw = visibleCodes[0]?.lastSeen || visibleCodes[0]?.testResults?.lastTested;
    const verifiedText = daysAgo(lastSeenRaw) ? `Last verified: ${daysAgo(lastSeenRaw)}` : "Last verified: unknown";
    const failedCount = codes.length - visibleCodes.length;

    // Overall success rate
    const totalTests = visibleCodes.reduce((sum, c) => sum + (c.testResults?.total || 0), 0);
    const totalWorked = visibleCodes.reduce((sum, c) => sum + (c.testResults?.worked || 0), 0);
    const overallRate = totalTests > 0 ? Math.round((totalWorked / totalTests) * 100) : null;
    const overallClass = getRateClass(overallRate);

    meta.innerHTML = `
      <div class="ukcp-meta-row">
        <span>${escapeHtml(verifiedText)}</span>
        <span class="ukcp-savings-pill ${orders > 0 ? "" : "ukcp-hidden"}">
          You've saved ${formatMoney(total)} across ${orders} order${orders === 1 ? "" : "s"}
        </span>
      </div>
      ${overallRate !== null ? `
      <div class="ukcp-meta-row">
        <span>Community success rate: <strong>${overallRate}%</strong></span>
      </div>
      <div class="ukcp-success-rate-bar">
        <div class="ukcp-success-rate-fill ${overallClass}" style="width: ${overallRate}%"></div>
      </div>
      ` : ""}
      ${failedCount > 0 ? `<div class="ukcp-meta-row" style="margin-top:6px">${failedCount} code${failedCount === 1 ? "" : "s"} hidden after reports</div>` : ""}
    `;
    panel.appendChild(meta);

    // Actions
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "ukcp-panel-actions";

    const tryAllBtn = document.createElement("button");
    tryAllBtn.className = "ukcp-action-btn";
    tryAllBtn.innerHTML = "🚀 Try all codes";
    tryAllBtn.title = "Auto-fill each code into the promo input at checkout";
    tryAllBtn.addEventListener("click", () => runAutoTrySequence(visibleCodes, tryAllBtn));
    actionsDiv.appendChild(tryAllBtn);

    const copyBestBtn = document.createElement("button");
    copyBestBtn.className = "ukcp-action-btn secondary";
    copyBestBtn.innerHTML = "📋 Copy best";
    copyBestBtn.title = "Copy the highest success-rate code";
    copyBestBtn.addEventListener("click", async () => {
      const best = visibleCodes[0];
      if (!best) return;
      const filled = autoFillCode(best.code);
      await copyToClipboard(best.code);
      showCopiedToast(best.code, filled);
    });
    actionsDiv.appendChild(copyBestBtn);

    panel.appendChild(actionsDiv);

    // Codes list
    const codesDiv = document.createElement("div");
    codesDiv.className = "ukcp-codes";

    if (visibleCodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "ukcp-empty";
      empty.textContent = "All codes marked as failed. Refresh to re-check.";
      codesDiv.appendChild(empty);
    }

    for (const c of visibleCodes) {
      const rate = getCodeSuccess(c);
      const rateClass = getRateClass(rate);
      const sources = c.sources || [c.source || "unknown"];
      const sourceBadges = sources.map(s =>
        `<span class="ukcp-source-badge ukcp-source-${escapeHtml(s).replace(/[^a-z0-9-]/gi, "")}">${escapeHtml(s)}</span>`
      ).join(" ");

      const item = document.createElement("div");
      item.className = "ukcp-code-item";

      item.innerHTML = `
        <div class="ukcp-code-header">
          <div class="ukcp-code-text">${escapeHtml(c.code)}</div>
          ${rate !== null ? `<div class="ukcp-code-rate ${rateClass}">
            <span class="ukcp-mini-bar"><span class="ukcp-mini-bar-fill ${rateClass}" style="width:${rate}%"></span></span>
            ${rate}%
          </div>` : ""}
        </div>
        <div class="ukcp-code-desc">${escapeHtml(c.description || "")}</div>
        <div class="ukcp-code-meta">
          ${c.type !== "unknown" ? `<span>📋 ${escapeHtml(c.type)}</span>` : ""}
          ${c.expiry ? `<span>⏰ ${escapeHtml(c.expiry)}</span>` : ""}
          ${sourceBadges}
        </div>
      `;

      const actionWrap = document.createElement("div");
      actionWrap.className = "ukcp-code-actions";

      const copyBtn = document.createElement("button");
      copyBtn.className = "ukcp-copy-btn";
      copyBtn.textContent = "📋 Copy Code";
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const filled = autoFillCode(c.code);
        await copyToClipboard(c.code);
        showCopiedToast(c.code, filled);
      });
      actionWrap.appendChild(copyBtn);

      const tryBtn = document.createElement("button");
      tryBtn.className = "ukcp-copy-btn secondary";
      tryBtn.textContent = "🚀 Try";
      tryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        runSingleAutoTry(c, tryBtn);
      });
      actionWrap.appendChild(tryBtn);

      const failBtn = document.createElement("button");
      failBtn.className = "ukcp-fail-btn";
      failBtn.textContent = "❌ Not working";
      failBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        reportFailed(c.code, domain);
      });
      actionWrap.appendChild(failBtn);

      item.appendChild(actionWrap);
      codesDiv.appendChild(item);
    }

    panel.appendChild(codesDiv);
    document.body.appendChild(panel);
  }

  // ─── CHECKOUT FLOATER ─────────────────────────────────────────────────────
  function buildCheckoutFloater(codes, storeData, domain) {
    const input = findCheckoutInput();
    if (!input) return;

    let floater = document.getElementById("uk-coupon-checkout");
    if (floater) floater.remove();

    const visibleCodes = codes.filter(c => !isCodeFailed(c.code, domain));
    if (visibleCodes.length === 0) return;

    floater = document.createElement("div");
    floater.id = "uk-coupon-checkout";
    const logoUrl = getStoreLogoUrl(domain);

    floater.innerHTML = `
      <div class="ukcp-checkout-head">
        <img class="ukcp-checkout-logo" src="${logoUrl}" alt="" onerror="this.style.display='none'">
        <h4>${escapeHtml(storeData.name || domain)} coupons</h4>
        <span class="ukcp-checkout-close">✕</span>
      </div>
      <div class="ukcp-checkout-status" id="ukcp-checkout-status">Pick a code to try</div>
      <div class="ukcp-checkout-progress" id="ukcp-checkout-progress">
        <div class="ukcp-progress-bar">
          <div class="ukcp-progress-fill" id="ukcp-progress-fill"></div>
        </div>
        <div class="ukcp-progress-text" id="ukcp-progress-text">0/0</div>
      </div>
      <div class="ukcp-checkout-list" id="ukcp-checkout-list"></div>
    `;

    floater.querySelector(".ukcp-checkout-close").addEventListener("click", () => {
      floater.classList.remove("ukcp-show");
    });

    const list = floater.querySelector("#ukcp-checkout-list");
    visibleCodes.forEach((c, idx) => {
      const rate = getCodeSuccess(c);
      const rateClass = getRateClass(rate);
      const row = document.createElement("div");
      row.className = "ukcp-checkout-item";
      row.dataset.code = c.code;
      row.innerHTML = `
        <div>
          <div class="ukcp-checkout-code">${escapeHtml(c.code)}</div>
          ${rate !== null ? `<div class="ukcp-checkout-rate ${rateClass}">${rate}% success</div>` : ""}
        </div>
        <button class="ukcp-checkout-try">Try</button>
      `;
      row.querySelector(".ukcp-checkout-try").addEventListener("click", () => {
        runSingleAutoTry(c, row.querySelector(".ukcp-checkout-try"));
      });
      list.appendChild(row);
    });

    document.body.appendChild(floater);
    positionFloater(floater, input);
    floater.classList.add("ukcp-show");

    // Reposition on resize
    window.addEventListener("resize", () => positionFloater(floater, input), { passive: true });
  }

  function positionFloater(floater, input) {
    const rect = input.getBoundingClientRect();
    const floaterRect = floater.getBoundingClientRect();
    let top = rect.bottom + 10 + window.scrollY;
    let left = rect.left + window.scrollX;

    // Keep inside viewport
    if (left + floaterRect.width > window.innerWidth - 20) {
      left = window.innerWidth - floaterRect.width - 20;
    }
    if (top + floaterRect.height > window.innerHeight - 20) {
      top = rect.top - floaterRect.height - 10 + window.scrollY;
    }

    floater.style.top = `${top}px`;
    floater.style.left = `${left}px`;
  }

  // ─── AUTO-TRY LOGIC ───────────────────────────────────────────────────────
  function setCheckoutStatus(message, type) {
    const status = document.getElementById("uk-coupon-checkout-status");
    if (!status) return;
    status.textContent = message;
    status.className = "ukcp-checkout-status" + (type ? " ukcp-" + type : "");
  }

  function runSingleAutoTry(codeObj, triggerBtn) {
    const input = findCheckoutInput();
    if (!input) {
      setCheckoutStatus("No promo input found on this page.", "fail");
      return;
    }

    if (triggerBtn) {
      triggerBtn.disabled = true;
      triggerBtn.textContent = "…";
    }

    // Show progress bar
    const progressBar = document.getElementById("ukcp-checkout-progress");
    const progressFill = document.getElementById("ukcp-progress-fill");
    const progressText = document.getElementById("ukcp-progress-text");
    if (progressBar) progressBar.classList.add("ukcp-active");
    if (progressFill) {
      progressFill.style.width = "0%";
      void progressFill.offsetWidth; // force reflow for a smooth 0 -> 50% animation
      progressFill.style.width = "50%";
    }
    if (progressText) progressText.textContent = "Trying…";

    setCheckoutStatus(`Trying "${codeObj.code}"…`, "working");
    applyCodeToInput(input, codeObj.code);

    try {
      const applyBtn = findApplyButton(input);
      if (applyBtn) applyBtn.click();
    } catch (e) {
      console.log("[UK Coupon Checker] Could not auto-click apply button", e);
    }

    // Detect result and update UI
    setTimeout(() => {
      const result = detectCodeResult();
      const icon = result === 'success' ? '✅' : result === 'failure' ? '❌' : '❓';
      
      if (progressFill) progressFill.style.width = "100%";
      if (progressText) progressText.textContent = icon;
      
      setCheckoutStatus(`"${codeObj.code}" ${result === 'success' ? 'worked!' : result === 'failure' ? 'failed' : 'applied'}. Did it work?`, result === 'success' ? 'success' : result === 'failure' ? 'fail' : 'working');
      
      // Mark the row as tried
      const row = document.querySelector(`.ukcp-checkout-item[data-code="${CSS.escape(codeObj.code)}"]`);
      if (row) {
        row.classList.add(result === 'failure' ? 'ukcp-failed' : 'ukcp-tried');
      }
      
      if (triggerBtn) {
        triggerBtn.textContent = "Try";
        triggerBtn.disabled = false;
      }
      
      // Hide progress bar after 3 seconds
      setTimeout(() => {
        if (progressBar) progressBar.classList.remove("ukcp-active");
      }, 3000);
    }, 1500);
  }

  function detectCodeResult() {
    // Look for common success/failure text patterns in the page
    const bodyText = document.body.innerText.toLowerCase();

    // Success patterns
    const successPatterns = [
      "code applied",
      "coupon applied",
      "discount applied",
      "promo applied",
      "voucher applied",
      "code successfully",
      "coupon successfully",
      "discount successfully",
    ];

    // Failure patterns
    const failurePatterns = [
      "invalid code",
      "expired code",
      "code not found",
      "coupon invalid",
      "coupon expired",
      "promo invalid",
      "promo expired",
      "voucher invalid",
      "voucher expired",
      "code does not exist",
      "coupon does not exist",
      "not a valid code",
      "not a valid coupon",
    ];

    for (const pattern of successPatterns) {
      if (bodyText.includes(pattern)) return 'success';
    }

    for (const pattern of failurePatterns) {
      if (bodyText.includes(pattern)) return 'failure';
    }

    return 'unknown';
  }

  function runAutoTrySequence(codes, panelBtn) {
    const input = findCheckoutInput();
    if (!input) {
      GM_notification({ title: "UK Coupon Checker", text: "No promo code box found on this page.", timeout: 3000 });
      return;
    }

    if (panelBtn) {
      panelBtn.disabled = true;
      panelBtn.textContent = "Trying…";
    }

    const sorted = sortCodesBySuccess(codes);
    const results = [];
    let index = 0;
    let progressBar, progressFill, progressText;

    function tryNext() {
      if (index >= sorted.length) {
        // All codes tried — hide progress bar and show summary
        if (progressBar) progressBar.classList.remove("ukcp-active");
        showResultsSummary(results, () => {
          if (panelBtn) {
            panelBtn.disabled = false;
            panelBtn.textContent = "🚀 Try all codes";
          }
        });
        return;
      }

      const c = sorted[index++];
      setCheckoutStatus(`Trying "${c.code}" (${index}/${sorted.length})…`, "working");
      applyCodeToInput(input, c.code);

      try {
        const applyBtn = findApplyButton(input);
        if (applyBtn) applyBtn.click();
      } catch (e) {}

      // Update progress bar
      const progress = (index / sorted.length) * 100;
      if (progressFill) progressFill.style.width = `${progress}%`;
      if (progressText) progressText.textContent = `${index}/${sorted.length}`;

      // Wait 2 seconds for the site to respond, then move to next
      setTimeout(() => {
        const result = detectCodeResult();
        results.push({ code: c.code, status: result });
        
        // Mark the row as tried
        const row = document.querySelector(`.ukcp-checkout-item[data-code="${CSS.escape(c.code)}"]`);
        if (row) {
          row.classList.add(result === 'failure' ? 'ukcp-failed' : 'ukcp-tried');
        }
        
        tryNext();
      }, 2000);
    }

    // Show checkout floater if not already visible
    buildCheckoutFloater(codes, { name: document.querySelector(".ukcp-header h3")?.textContent || getCurrentDomain() }, getCurrentDomain());

    // Grab the progress elements now the floater exists in the DOM
    progressBar = document.getElementById("ukcp-checkout-progress");
    progressFill = document.getElementById("ukcp-progress-fill");
    progressText = document.getElementById("ukcp-progress-text");
    if (progressBar) progressBar.classList.add("ukcp-active");

    tryNext();
  }

  function showCodeResultPrompt(codeObj, callback) {
    const overlay = document.getElementById("uk-coupon-modal-overlay") || createModalOverlay();
    overlay.innerHTML = "";

    const modal = document.createElement("div");
    modal.className = "ukcp-modal";
    modal.innerHTML = `
      <h3>Did "${escapeHtml(codeObj.code)}" work?</h3>
      <p>Some sites don't show instant feedback. Choose the result you see on the checkout page.</p>
      <div class="ukcp-modal-actions">
        <button class="ukcp-secondary" id="ukcp-result-fail">❌ No, try next</button>
        <button class="ukcp-primary" id="ukcp-result-pass">✅ Yes, it worked</button>
      </div>
    `;
    overlay.appendChild(modal);
    overlay.classList.add("ukcp-show");

    modal.querySelector("#ukcp-result-fail").addEventListener("click", () => {
      overlay.classList.remove("ukcp-show");
      callback(false);
    });
    modal.querySelector("#ukcp-result-pass").addEventListener("click", () => {
      overlay.classList.remove("ukcp-show");
      callback(true);
    });
  }

  function showResultsSummary(results, callback) {
    const overlay = document.getElementById("uk-coupon-modal-overlay") || createModalOverlay();
    overlay.innerHTML = "";

    const modal = document.createElement("div");
    modal.className = "ukcp-modal";

    let html = `
      <h3>Tried ${results.length} code${results.length === 1 ? "" : "s"}</h3>
      <p>Which one worked (if any)?</p>
      <div class="ukcp-results-list">
    `;

    results.forEach((r, idx) => {
      const statusIcon = r.status === 'success' ? '✅' : r.status === 'failure' ? '❌' : '❓';
      html += `
        <div class="ukcp-result-item" data-index="${idx}">
          <span class="ukcp-result-code">${escapeHtml(r.code)}</span>
          <span class="ukcp-result-status">${statusIcon}</span>
          <button class="ukcp-result-mark" data-index="${idx}">This one worked</button>
        </div>
      `;
    });

    html += `
      </div>
      <div class="ukcp-modal-actions">
        <button class="ukcp-secondary" id="ukcp-result-none">None worked</button>
      </div>
    `;

    modal.innerHTML = html;
    overlay.appendChild(modal);
    overlay.classList.add("ukcp-show");

    // Handle "This one worked" clicks
    modal.querySelectorAll(".ukcp-result-mark").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.index);
        const code = results[idx].code;
        overlay.classList.remove("ukcp-show");
        setCheckoutStatus(`✅ "${code}" applied!`, "success");
        showSavingsPrompt(code, callback);
      });
    });

    // Handle "None worked"
    modal.querySelector("#ukcp-result-none").addEventListener("click", () => {
      overlay.classList.remove("ukcp-show");
      setCheckoutStatus("No codes worked. Try manually?", "fail");
      callback();
    });
  }

  // ─── MAIN ─────────────────────────────────────────────────────────────────
  async function main() {
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
        const sorted = sortCodesBySuccess(storeData.codes);
        buildPanel(sorted, storeData, domain);
        buildCheckoutFloater(sorted, storeData, domain);
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
