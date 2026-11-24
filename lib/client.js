window.__ModuleLoader__.load({ id: "dsh-upgrade", factory: (require) => {
"use strict";
var __dsh_upgrade_client = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/client/index.ts
  var client_exports = {};
  __export(client_exports, {
    apply: () => apply
  });

  // src/client/inject.ts
  var MARK = "data-dshu-entry";
  var GROUP_SELECTOR = "[data-dshm-footer-group]";
  var ACTION_SLOT_SELECTOR = '[data-slot="sidebar.footer.action"]';
  var LAUNCHER_SELECTOR = '[data-slot="settings.launcher"]';
  var STYLE_ID = "dshu-entry-style";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var mountedEntries = /* @__PURE__ */ new WeakMap();
  var STYLE_TEXT = [
    ".dshu-entry{position:relative;flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;margin:0 2px;padding:0;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}",
    ".dshu-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,inherit)}",
    ".dshu-entry:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:-2px}",
    ".dshu-entry[data-busy]{opacity:.6;cursor:default}",
    ".dshu-entry[data-busy] svg{animation:dshu-spin 1s linear infinite}",
    ".dshu-entry .dshu-dot{display:none;position:absolute;top:4px;right:4px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#e5484d)}",
    ".dshu-entry[data-has-update] .dshu-dot{display:block}",
    // 没更新时整颗收起来；这条必须写在 .dshu-entry{display:inline-flex} 之后才压得住它。
    ".dshu-entry[hidden]{display:none}",
    "@keyframes dshu-spin{to{transform:rotate(360deg)}}"
  ].join("\n");
  var entryStates = /* @__PURE__ */ new WeakMap();
  function locateSeat(doc) {
    const group = doc.querySelector(GROUP_SELECTOR);
    if (group !== null && group.parentElement !== null) {
      return { parent: group.parentElement, before: group.nextSibling };
    }
    const actionSlot = doc.querySelector(ACTION_SLOT_SELECTOR);
    if (actionSlot !== null) return { parent: actionSlot, before: null };
    const launcher = doc.querySelector(LAUNCHER_SELECTOR);
    if (launcher !== null && launcher.parentElement !== null) {
      return { parent: launcher.parentElement, before: null };
    }
    return null;
  }
  function createGlyph(doc) {
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    const arrow = doc.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M12 4v10");
    svg.appendChild(arrow);
    const head = doc.createElementNS(SVG_NS, "path");
    head.setAttribute("d", "M8 8l4-4 4 4");
    svg.appendChild(head);
    const tray = doc.createElementNS(SVG_NS, "path");
    tray.setAttribute("d", "M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15");
    svg.appendChild(tray);
    return svg;
  }
  function createEntry(doc, hooks) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "dshu-entry";
    button.setAttribute(MARK, "");
    button.setAttribute("aria-label", "\u68C0\u67E5\u66F4\u65B0");
    button.title = "\u68C0\u67E5\u66F4\u65B0";
    button.appendChild(createGlyph(doc));
    const dot = doc.createElement("span");
    dot.className = "dshu-dot";
    dot.setAttribute("aria-hidden", "true");
    button.appendChild(dot);
    button.addEventListener("click", () => hooks.onOpen());
    return button;
  }
  function ensureStyle(doc) {
    if (doc.getElementById(STYLE_ID) !== null) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = STYLE_TEXT;
    doc.head.appendChild(style);
  }
  function mountFooterEntry(doc, hooks) {
    const previous = mountedEntries.get(doc);
    if (previous !== void 0) previous();
    ensureStyle(doc);
    for (const stale of Array.from(doc.querySelectorAll(`[${MARK}]`))) stale.remove();
    const button = createEntry(doc, hooks);
    const frameHost = doc.defaultView !== null && typeof doc.defaultView.requestAnimationFrame === "function" && typeof doc.defaultView.cancelAnimationFrame === "function" ? doc.defaultView : null;
    let observer = null;
    let frame = null;
    let disposed = false;
    const settle = () => {
      if (disposed) return;
      const seat = locateSeat(doc);
      if (seat === null) {
        if (button.parentElement !== null) button.remove();
        return;
      }
      const placed = button.parentElement === seat.parent && (seat.before === button || button.nextSibling === seat.before);
      if (placed) return;
      seat.parent.insertBefore(button, seat.before);
      const remembered = entryStates.get(doc);
      if (remembered !== void 0) paintEntry(button, remembered);
    };
    const Observer = typeof MutationObserver === "function" ? MutationObserver : void 0;
    if (Observer !== void 0 && frameHost !== null && doc.body !== null) {
      observer = new Observer(() => {
        if (disposed || frame !== null) return;
        frame = frameHost.requestAnimationFrame(() => {
          frame = null;
          try {
            settle();
          } catch {
          }
        });
      });
      observer.observe(doc.body, { childList: true, subtree: true });
    }
    settle();
    const teardown = () => {
      disposed = true;
      if (observer !== null) observer.disconnect();
      if (frame !== null && frameHost !== null) {
        frameHost.cancelAnimationFrame(frame);
        frame = null;
      }
      button.remove();
      entryStates.delete(doc);
      const style = doc.getElementById(STYLE_ID);
      if (style !== null) style.remove();
      if (mountedEntries.get(doc) === teardown) mountedEntries.delete(doc);
    };
    mountedEntries.set(doc, teardown);
    return teardown;
  }
  function setEntryState(doc, state) {
    entryStates.set(doc, state);
    for (const entry of Array.from(doc.querySelectorAll(`[${MARK}]`))) {
      paintEntry(entry, state);
    }
  }
  function paintEntry(entry, state) {
    const visible = state.hasUpdate || state.busy || state.known === false;
    entry.hidden = !visible;
    if (state.hasUpdate) entry.setAttribute("data-has-update", "1");
    else entry.removeAttribute("data-has-update");
    if (state.busy) entry.setAttribute("data-busy", "1");
    else entry.removeAttribute("data-busy");
  }

  // src/client/market.ts
  var SUMMARY = "/dsh-market/api/v1/updates/summary";
  var UPDATES = "/dsh-market/api/v1/updates";
  var OPERATIONS = "/dsh-market/api/v1/operations";
  var MARKET_UNAVAILABLE = "MARKET_UNAVAILABLE";
  var OPERATION_UNKNOWN = "OPERATION_UNKNOWN";
  var MARKET_UNAUTHORIZED = "MARKET_UNAUTHORIZED";
  var UPDATE_FAILED = "UPDATE_FAILED";
  var UNAVAILABLE_MESSAGE = "\u63D2\u4EF6\u66F4\u65B0\u4E0D\u53EF\u7528";
  var UNAUTHORIZED_MESSAGE = "\u9700\u8981\u5148\u767B\u5F55 DSH";
  var UNKNOWN_OPERATION_MESSAGE = "\u5347\u7EA7\u8BB0\u5F55\u5DF2\u5931\u6548\uFF0C\u5BBF\u4E3B\u53EF\u80FD\u5DF2\u91CD\u542F";
  var PLUGIN_MARKET_UNAVAILABLE = "MARKET_UNAVAILABLE";
  var PLUGIN_OPERATION_UNKNOWN = "OPERATION_UNKNOWN";
  var PLUGIN_MARKET_UNAUTHORIZED = "MARKET_UNAUTHORIZED";
  var UNAVAILABLE_CODES = [
    PLUGIN_MARKET_UNAVAILABLE,
    PLUGIN_OPERATION_UNKNOWN,
    PLUGIN_MARKET_UNAUTHORIZED
  ];
  function isPluginUnavailableCode(code) {
    return typeof code === "string" && UNAVAILABLE_CODES.includes(code);
  }
  var OPERATION_STATES = [
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "rolled-back"
  ];
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isOperationStatus(value) {
    return typeof value === "string" && OPERATION_STATES.includes(value);
  }
  function withBase(base, path) {
    return base.replace(/\/+$/, "") + path;
  }
  function numberOrNull(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  function normalizeProgress(value) {
    if (!isRecord(value)) return void 0;
    const wait = {
      percent: numberOrNull(value.percent),
      phase: typeof value.phase === "string" && value.phase !== "" ? value.phase : null,
      detail: typeof value.detail === "string" && value.detail !== "" ? value.detail : null,
      done: numberOrNull(value.done),
      total: numberOrNull(value.total)
    };
    if (wait.percent === null && wait.done !== null && wait.total !== null && wait.total > 0) {
      wait.percent = Math.round(wait.done / wait.total * 100);
    }
    if (wait.percent === null && wait.phase === null && wait.detail === null) return void 0;
    if (wait.percent !== null) {
      const clamped = Math.min(100, Math.max(0, Math.round(wait.percent)));
      wait.percent = clamped;
    }
    return wait;
  }
  function normalizeWait(value) {
    if (!isRecord(value)) return void 0;
    const ids = [];
    if (Array.isArray(value.activeAgentIds)) {
      for (const item of value.activeAgentIds) {
        if (typeof item === "string" && item !== "") ids.push(item);
      }
    }
    const wait = {
      code: typeof value.code === "string" && value.code !== "" ? value.code : null,
      message: typeof value.message === "string" && value.message !== "" ? value.message : null,
      activeAgentIds: ids
    };
    if (wait.code === null && wait.message === null && ids.length === 0) return void 0;
    return wait;
  }
  function unavailableUpdates() {
    return { available: false, updatable: [] };
  }
  function unavailableOperation() {
    return {
      status: "failed",
      restartRequired: false,
      code: MARKET_UNAVAILABLE,
      message: UNAVAILABLE_MESSAGE,
      retryable: true
    };
  }
  function unknownOperation() {
    return {
      status: "failed",
      restartRequired: false,
      code: OPERATION_UNKNOWN,
      message: UNKNOWN_OPERATION_MESSAGE,
      retryable: false
    };
  }
  function unauthorizedOperation() {
    return {
      status: "failed",
      restartRequired: false,
      code: MARKET_UNAUTHORIZED,
      message: UNAUTHORIZED_MESSAGE,
      retryable: false
    };
  }
  function pollFailure(status) {
    if (status === 404) return unknownOperation();
    if (status === 401) return unauthorizedOperation();
    return unavailableOperation();
  }
  function failureDetails(body, status) {
    const fallback = status === 401 ? { code: MARKET_UNAUTHORIZED, message: UNAUTHORIZED_MESSAGE } : { code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE };
    if (!isRecord(body)) return fallback;
    const failure = isRecord(body.failure) ? body.failure : null;
    const code = failure !== null && typeof failure.code === "string" && failure.code !== "" ? failure.code : fallback.code;
    const message = failure !== null && typeof failure.message === "string" && failure.message !== "" ? failure.message : typeof body.error === "string" && body.error !== "" ? body.error : fallback.message;
    return { code, message };
  }
  function toPluginUpdate(value) {
    if (!isRecord(value)) return null;
    const name = value.name;
    const from = value.installedVersion;
    const to = value.latestVersion;
    if (typeof name !== "string" || name === "") return null;
    if (typeof from !== "string" || from === "") return null;
    if (typeof to !== "string" || to === "") return null;
    const update = { name, from, to };
    if (typeof value.publishedAt === "string" && value.publishedAt !== "") {
      update.publishedAt = value.publishedAt;
    }
    if (typeof value.repo === "string" && value.repo !== "") {
      update.repo = value.repo;
    }
    return update;
  }
  function requestHeaders(jsonBody) {
    const headers = { Accept: "application/json" };
    if (jsonBody) headers["Content-Type"] = "application/json";
    return headers;
  }
  async function readJsonBody(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  async function fetchPluginUpdates(fetchImpl = fetch, base = "") {
    try {
      const response = await fetchImpl(withBase(base, SUMMARY), {
        method: "GET",
        credentials: "same-origin",
        headers: requestHeaders(false)
      });
      if (response.ok !== true) return unavailableUpdates();
      const body = await readJsonBody(response);
      if (!isRecord(body) || !Array.isArray(body.packages)) return unavailableUpdates();
      const updatable = [];
      for (const entry of body.packages) {
        const update = toPluginUpdate(entry);
        if (update !== null) updatable.push(update);
      }
      const result = { available: true, updatable };
      if (typeof body.checked === "number" && Number.isInteger(body.checked) && body.checked >= 0) {
        result.checked = body.checked;
      }
      return result;
    } catch {
      return unavailableUpdates();
    }
  }
  async function startPluginUpdate(name, fetchImpl = fetch, base = "") {
    try {
      const response = await fetchImpl(withBase(base, UPDATES), {
        method: "POST",
        credentials: "same-origin",
        headers: requestHeaders(true),
        body: JSON.stringify({ packageName: name })
      });
      const body = await readJsonBody(response);
      if (response.ok !== true) {
        const failure = failureDetails(body, response.status);
        return { operationId: "", code: failure.code, message: failure.message };
      }
      if (!isRecord(body)) {
        return { operationId: "", code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE };
      }
      const operation = isRecord(body.operation) ? body.operation : null;
      if (operation !== null && typeof operation.operationId === "string" && operation.operationId !== "") {
        return { operationId: operation.operationId };
      }
      if (typeof body.operationId === "string" && body.operationId !== "") {
        return { operationId: body.operationId };
      }
      return { operationId: "", code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE };
    } catch {
      return { operationId: "", code: MARKET_UNAVAILABLE, message: UNAVAILABLE_MESSAGE };
    }
  }
  async function pollPluginOperation(operationId, fetchImpl = fetch, base = "") {
    if (operationId === "") return unknownOperation();
    try {
      const url = withBase(base, OPERATIONS) + `?operationId=${encodeURIComponent(operationId)}`;
      const response = await fetchImpl(url, {
        method: "GET",
        credentials: "same-origin",
        headers: requestHeaders(false)
      });
      if (response.ok !== true) return pollFailure(response.status);
      const body = await readJsonBody(response);
      if (!isRecord(body) || !isRecord(body.operation)) return unavailableOperation();
      const operation = body.operation;
      if (!isOperationStatus(operation.state)) return unavailableOperation();
      const outcome = isRecord(operation.outcome) ? operation.outcome : {};
      const result = {
        status: operation.state,
        restartRequired: outcome.restartRequired === true
      };
      const progress = normalizeProgress(operation.progress);
      if (progress !== void 0) result.progress = progress;
      const wait = normalizeWait(operation.wait);
      if (wait !== void 0) result.wait = wait;
      const failure = isRecord(operation.failure) ? operation.failure : null;
      if (failure !== null) {
        if (typeof failure.code === "string" && failure.code !== "") result.code = failure.code;
        if (typeof failure.message === "string" && failure.message !== "") {
          result.message = failure.message;
        }
        if (typeof failure.retryable === "boolean") result.retryable = failure.retryable;
      }
      if (result.status === "failed") {
        if (result.code === void 0) result.code = UPDATE_FAILED;
        if (result.retryable === void 0) result.retryable = false;
      }
      return result;
    } catch {
      return unavailableOperation();
    }
  }

  // src/client/batch.ts
  var DEFAULT_POLL_INTERVAL_MS = 800;
  var MAX_POLLS = 1500;
  var DEFAULT_STALLED_WAIT_MS = 18e4;
  var HOST_BUSY_CODE = "OPERATION_BUSY";
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  function itemOf(name, state) {
    return { name, state, percent: null, detail: null, message: null, unavailable: false };
  }
  function restNames(names, from) {
    const rest = [];
    for (let index = from; index < names.length; index += 1) rest.push(names[index] ?? "");
    return rest;
  }
  function moveKey(operation) {
    const progress = operation.progress;
    return [
      operation.status,
      String(progress?.percent ?? ""),
      String(progress?.done ?? ""),
      String(progress?.detail ?? "")
    ].join("|");
  }
  function stalledReason(operation) {
    const agents = operation.wait?.activeAgentIds.length ?? 0;
    if (operation.status === "queued" || agents > 0) {
      return agents > 0 ? "\u8FD8\u6CA1\u5F00\u59CB\u5347\u7EA7\uFF1A\u7B49 " + String(agents) + " \u4E2A\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u7ED3\u675F\u540E\u518D\u70B9" : "\u8FD8\u6CA1\u5F00\u59CB\u5347\u7EA7\uFF1A\u4E00\u76F4\u5728\u6392\u961F\uFF0C\u7A0D\u540E\u518D\u70B9";
    }
    return "\u5347\u7EA7\u8FD8\u5728\u540E\u53F0\u8DD1\uFF0C\u5148\u4E0D\u7B49\u4E86\uFF1A\u7A0D\u540E\u6253\u5F00\u9762\u677F\u770B\u7ED3\u679C";
  }
  function runningMessage(operation) {
    if (operation.status !== "queued") return null;
    const agents = operation.wait?.activeAgentIds.length ?? 0;
    return agents > 0 ? "\u7B49 " + String(agents) + " \u4E2A\u8FD0\u884C\u4E2D\u7684\u4F1A\u8BDD\u7ED3\u675F" : null;
  }
  function settleItem(name, operation) {
    const item = itemOf(name, "succeeded");
    if (operation.status === "succeeded") return item;
    item.state = "failed";
    switch (operation.status) {
      case "failed":
        if (isPluginUnavailableCode(operation.code)) {
          item.unavailable = true;
          item.message = UNAVAILABLE_MESSAGE;
        } else {
          item.message = operation.message ?? "\u5347\u7EA7\u5931\u8D25";
        }
        break;
      case "rolled-back":
        item.message = operation.message === void 0 ? "\u5DF2\u56DE\u6EDA" : "\u5DF2\u56DE\u6EDA\uFF1A" + operation.message;
        break;
      case "cancelled":
        item.message = "\u5DF2\u53D6\u6D88";
        break;
    }
    return item;
  }
  async function upgradeOne(name, f, base, interval, stalledWaitMs, emit) {
    const started = await startPluginUpdate(name, f, base);
    if (started.operationId === "") {
      const item = itemOf(name, "failed");
      if (isPluginUnavailableCode(started.code)) {
        item.unavailable = true;
        item.message = UNAVAILABLE_MESSAGE;
      } else {
        item.message = started.message !== void 0 && started.message !== "" ? started.message : "\u5347\u7EA7\u5931\u8D25";
      }
      emit({ kind: "settled", item });
      return {
        ok: false,
        restartRequired: false,
        hostBusy: started.code === HOST_BUSY_CODE
      };
    }
    let lastMove = "";
    let movedAt = Date.now();
    for (let round = 0; round < MAX_POLLS; round += 1) {
      const operation = await pollPluginOperation(started.operationId, f, base);
      if (operation.status === "queued" || operation.status === "running") {
        const move = moveKey(operation);
        if (move !== lastMove) {
          lastMove = move;
          movedAt = Date.now();
        } else if (Date.now() - movedAt >= stalledWaitMs) {
          const item3 = itemOf(name, "failed");
          item3.message = stalledReason(operation);
          emit({ kind: "settled", item: item3 });
          return { ok: false, restartRequired: false, hostBusy: false };
        }
        const item2 = itemOf(name, "running");
        item2.percent = operation.progress?.percent ?? null;
        item2.detail = operation.progress?.detail ?? null;
        item2.message = runningMessage(operation);
        emit({ kind: "running", item: item2 });
        await sleep(interval);
        continue;
      }
      const item = settleItem(name, operation);
      emit({ kind: "settled", item });
      return {
        ok: item.state === "succeeded",
        restartRequired: item.state === "succeeded" && operation.restartRequired,
        hostBusy: false
      };
    }
    const timeout = itemOf(name, "failed");
    timeout.message = "\u5347\u7EA7\u8D85\u65F6\uFF0C\u7A0D\u540E\u91CD\u8BD5";
    emit({ kind: "settled", item: timeout });
    return { ok: false, restartRequired: false, hostBusy: false };
  }
  async function runBatch(names, f, base, options = {}) {
    const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const stalledWaitMs = options.stalledWaitMs ?? DEFAULT_STALLED_WAIT_MS;
    const summary = { succeeded: [], failed: [], skipped: [], restartRequired: false };
    const emit = (event) => {
      try {
        options.onEvent?.(event);
      } catch {
      }
    };
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index];
      if (name === void 0) {
        summary.skipped.push("");
        continue;
      }
      if (options.cancelled?.() === true) {
        summary.skipped.push(...restNames(names, index));
        return summary;
      }
      const outcome = await upgradeOne(name, f, base, interval, stalledWaitMs, emit);
      if (outcome.ok) {
        summary.succeeded.push(name);
        if (outcome.restartRequired) summary.restartRequired = true;
      } else {
        summary.failed.push(name);
        if (outcome.hostBusy) {
          summary.skipped.push(...restNames(names, index + 1));
          return summary;
        }
      }
    }
    return summary;
  }

  // src/client/panel.ts
  var PANEL_MARK = "data-dshu-panel";
  var STYLE_ID2 = "dshu-panel-style";
  var STATUS_PATH = "/dsh-upgrade/api/status";
  var CHECK_PATH = "/dsh-upgrade/api/check";
  var RELEASES_PATH = "/dsh-upgrade/api/releases";
  var UPGRADE_PATH = "/dsh-upgrade/api/upgrade";
  var RESTART_STATUS_PATH = "/dsh-restart/api/status";
  var RESTART_PRECHECK_PATH = "/dsh-restart/api/precheck";
  var RESTART_PATH = "/dsh-restart/api/restart";
  var CONFIRM_COOLDOWN_MS = 800;
  var HOST_HEADERS = { "x-dsh-upgrade": "1" };
  var RESTART_HEADERS = { "x-dsh-restart": "1" };
  var RESTART_STAGE_LABELS = {
    config: "\u914D\u7F6E\u68C0\u67E5",
    compat: "\u63D2\u4EF6\u517C\u5BB9\u68C0\u67E5",
    boot: "\u542F\u52A8\u5192\u70DF\u68C0\u67E5"
  };
  var RELEASE_PAGE = "https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v";
  var PHASE_LABELS = {
    backup: "\u5907\u4EFD",
    precheck: "\u9884\u68C0",
    install: "\u5B89\u88C5",
    verify: "\u6821\u9A8C",
    restart: "\u91CD\u542F",
    done: "\u5B8C\u6210",
    fail: "\u5931\u8D25",
    rollback: "\u56DE\u6EDA"
  };
  var HOST_PHASES = Object.keys(PHASE_LABELS).filter(
    (phase) => phase !== "fail" && phase !== "rollback"
  );
  var STYLE_TEXT2 = [
    ".dshu-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.32)}",
    ".dshu-panel{position:relative;display:flex;flex-direction:column;gap:0;width:min(560px,100%);max-height:min(80vh,720px);overflow:hidden;padding:0;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,var(--dsw-alias-bg-primary,#fff));color:var(--dsw-alias-label-primary,inherit);box-shadow:0 18px 48px rgba(0,0,0,.24);font:14px/1.55 var(--dsw-font-family,system-ui,sans-serif)}",
    // 头部不参与滚动：外壳 overflow:hidden，只有 .dshu-body 滚。
    ".dshu-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:18px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
    ".dshu-body{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:auto;padding:14px 20px 20px}",
    ".dshu-title{font-size:16px;font-weight:600}",
    ".dshu-close{flex:none;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-size:18px;line-height:1;cursor:pointer}",
    ".dshu-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}",
    ".dshu-section{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));border-radius:var(--dsw-radius-md,8px)}",
    ".dshu-section h3{margin:0;font-size:14px;font-weight:600}",
    ".dshu-versions{display:flex;flex-wrap:wrap;align-items:baseline;gap:6px}",
    ".dshu-version{font-variant-numeric:tabular-nums}",
    ".dshu-current{color:var(--dsw-alias-label-secondary,inherit)}",
    ".dshu-arrow{color:var(--dsw-alias-label-tertiary,inherit)}",
    ".dshu-target{font-weight:600;color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
    ".dshu-channel{margin-left:4px;color:var(--dsw-alias-label-tertiary,inherit)}",
    ".dshu-row{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}",
    ".dshu-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer}",
    ".dshu-toggle input{accent-color:var(--dsw-alias-state-business-primary,#4d6bfe)}",
    ".dshu-refresh,.dshu-upgrade-btn,.dshu-release-toggle{padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font:inherit;cursor:pointer}",
    ".dshu-upgrade-btn{background:var(--dsw-alias-state-business-primary,#4d6bfe);border-color:transparent;color:#fff;font-weight:600}",
    ".dshu-upgrade-btn:disabled{opacity:.55;cursor:not-allowed}",
    ".dshu-upgrade-btn[data-blocked]{background:transparent;border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary,inherit);font-weight:400}",
    ".dshu-release{display:flex;flex-direction:column;gap:8px}",
    ".dshu-release[hidden]{display:none}",
    ".dshu-release-row{display:flex;flex-direction:column;gap:6px}",
    ".dshu-release-toggle{align-self:flex-start;font-weight:600}",
    ".dshu-release-body{padding-left:10px;border-left:2px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
    ".dshu-release-body[hidden]{display:none}",
    ".dshu-release-items{margin:0;padding-left:18px}",
    ".dshu-release-link{color:var(--dsw-alias-state-business-primary,#4d6bfe);text-decoration:none;font-size:13px}",
    ".dshu-release-hint{display:flex;gap:8px;align-items:center;color:var(--dsw-alias-label-secondary,inherit)}",
    ".dshu-plugin-list{display:flex;flex-direction:column;gap:8px}",
    ".dshu-plugins-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:0}",
    ".dshu-plugins-head h3{margin:0}",
    ".dshu-plugins-head .dshu-upgrade-all{margin-left:auto}",
    ".dshu-upgrade-all,.dshu-restart{padding:4px 10px;font-size:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:var(--dsw-radius-sm,6px);background:transparent;color:inherit;font-family:inherit;cursor:pointer}",
    ".dshu-upgrade-all:disabled,.dshu-restart:disabled{opacity:.5;cursor:default}",
    ".dshu-plugin-summary{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}",
    ".dshu-plugin-summary[hidden]{display:none}",
    ".dshu-plugin{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03))}",
    ".dshu-plugin-line{display:flex;justify-content:space-between;gap:10px;align-items:baseline}",
    ".dshu-plugin-name{font-weight:600;overflow:hidden;text-overflow:ellipsis}",
    ".dshu-plugin-version{color:var(--dsw-alias-label-secondary,inherit);font-variant-numeric:tabular-nums}",
    ".dshu-plugin-state{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}",
    ".dshu-plugin-progress{display:flex;flex-direction:column;gap:4px}",
    ".dshu-plugin-progress[hidden]{display:none}",
    ".dshu-plugin-progress-text{font-size:12px;color:var(--dsw-alias-label-tertiary,inherit)}",
    ".dshu-plugin-empty,.dshu-plugin-unavailable{color:var(--dsw-alias-label-secondary,inherit)}",
    ".dshu-plugin-state[data-error]{color:var(--dsw-alias-state-error-primary,#e5484d)}",
    // 进度条：有百分比就定宽，没有就左右来回跑（pnpm 还没给总量）。
    ".dshu-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}",
    ".dshu-bar[hidden]{display:none}",
    ".dshu-bar-fill{height:100%;width:0;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .25s ease}",
    ".dshu-bar[data-indeterminate] .dshu-bar-fill{width:38%;animation:dshu-slide 1.1s ease-in-out infinite}",
    "@keyframes dshu-slide{0%{margin-left:-38%}100%{margin-left:100%}}",
    "@media (prefers-reduced-motion:reduce){.dshu-bar[data-indeterminate] .dshu-bar-fill{animation:none;margin-left:0;width:100%;opacity:.4}}",
    ".dshu-host-bar{height:4px;border-radius:2px;background:var(--dsw-alias-border-l2,rgba(0,0,0,.1));overflow:hidden}",
    ".dshu-host-bar[hidden]{display:none}",
    ".dshu-host-bar .dshu-bar-fill{height:100%;width:0;background:var(--dsw-alias-state-business-primary,#4d6bfe);transition:width .25s ease}",
    ".dshu-progress{display:flex;flex-direction:column;gap:4px;padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.03));font-size:13px}",
    ".dshu-progress[hidden]{display:none}",
    '.dshu-progress-line::before{content:"\u203A ";color:var(--dsw-alias-label-tertiary,inherit)}',
    // pre-line 只为多行错误（事实 + 可复制命令）保住换行，单行红条看起来不变
    ".dshu-error{padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-state-error-bg,rgba(229,72,77,.12));color:var(--dsw-alias-state-error-primary,#e5484d);white-space:pre-line}",
    ".dshu-notice{padding:10px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-state-business-bg,rgba(77,107,254,.1));font-size:13px}",
    ".dshu-notice[hidden]{display:none}"
  ].join("\n");
  var activeViews = /* @__PURE__ */ new WeakMap();
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function asString(value) {
    return typeof value === "string" ? value : "";
  }
  function asStringOrNull(value) {
    return typeof value === "string" && value !== "" ? value : null;
  }
  function joinUrl(base, path) {
    return base.replace(/\/+$/, "") + path;
  }
  function fetchOf(doc) {
    const globalCandidate = globalThis.fetch;
    if (typeof globalCandidate === "function") {
      return globalCandidate.bind(globalThis);
    }
    const view = doc.defaultView;
    if (view !== null && typeof view.fetch === "function") {
      return view.fetch.bind(view);
    }
    return (async () => {
      throw new Error("\u5F53\u524D\u73AF\u5883\u6CA1\u6709 fetch");
    });
  }
  function ensureStyle2(doc) {
    if (doc.getElementById(STYLE_ID2) !== null) return;
    const style = doc.createElement("style");
    style.id = STYLE_ID2;
    style.textContent = STYLE_TEXT2;
    doc.head.appendChild(style);
  }
  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    node.className = className;
    if (text !== void 0) node.textContent = text;
    return node;
  }
  function buttonOf(doc, className, text) {
    const node = doc.createElement("button");
    node.type = "button";
    node.className = className;
    node.textContent = text;
    return node;
  }
  function live(view, token) {
    return !view.closed && view.token === token;
  }
  function hasNewerTarget(survey) {
    return survey !== null && survey.target !== "" && survey.target !== survey.current;
  }
  function hasHostUpdate(survey) {
    return hasNewerTarget(survey) || survey !== null && survey.restartRequired;
  }
  function normalizeSurvey(value) {
    if (!isRecord2(value)) return null;
    const current = asString(value.current);
    if (current === "") return null;
    const channelsRaw = isRecord2(value.channels) ? value.channels : {};
    const blockedRaw = isRecord2(value.blocked) ? value.blocked : null;
    return {
      current,
      channels: {
        latest: asString(channelsRaw.latest),
        next: asString(channelsRaw.next),
        alpha: asString(channelsRaw.alpha)
      },
      target: asStringOrNull(value.target) ?? "",
      blocked: blockedRaw === null ? null : { code: asString(blockedRaw.code), message: asString(blockedRaw.message) },
      includePrerelease: value.includePrerelease === true,
      restartRequired: value.restartRequired === true
    };
  }
  function normalizeReleases(value) {
    if (!isRecord2(value)) return { releases: [], degraded: true };
    const degraded = value.degraded === true;
    const list = [];
    if (Array.isArray(value.releases)) {
      for (const entry of value.releases) {
        if (!isRecord2(entry)) continue;
        const version = asString(entry.version);
        if (version === "") continue;
        const items = [];
        if (Array.isArray(entry.items)) {
          for (const item of entry.items) {
            if (typeof item === "string" && item !== "") items.push(item);
          }
        }
        list.push({
          version,
          channel: asString(entry.channel),
          publishedAt: asString(entry.publishedAt),
          items,
          url: asString(entry.url)
        });
      }
    }
    return { releases: list, degraded };
  }
  function channelOf(survey, version) {
    if (survey.channels.alpha !== "" && survey.channels.alpha === version) return "alpha";
    if (survey.channels.next !== "" && survey.channels.next === version) return "next";
    if (survey.channels.latest !== "" && survey.channels.latest === version) return "latest";
    return "";
  }
  function releaseTitle(release) {
    const parts = ["v" + release.version];
    if (release.channel !== "") parts.push(release.channel);
    if (release.publishedAt !== "") parts.push(release.publishedAt.slice(0, 10));
    return parts.join(" \xB7 ");
  }
  function phaseLabel(phase) {
    const label = PHASE_LABELS[phase];
    return label === void 0 ? phase === "" ? "\u8FDB\u884C\u4E2D" : phase : label;
  }
  function errorTextOf(value) {
    if (typeof value === "string" && value !== "") return value;
    if (isRecord2(value)) {
      const message = asString(value.message);
      if (message !== "") return message;
      const code = asString(value.code);
      if (code !== "") return code;
    }
    return "\u5347\u7EA7\u5931\u8D25";
  }
  function failureTextOf(event) {
    if (event.error !== void 0 && event.error !== null) return errorTextOf(event.error);
    const message = asString(event.message);
    return message !== "" ? message : "\u5347\u7EA7\u5931\u8D25";
  }
  async function readJsonBody2(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  async function requestJson(f, url, init) {
    const response = await f(url, init);
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  }
  function drainLines(buffer, onLine) {
    let rest = buffer;
    for (; ; ) {
      const index = rest.indexOf("\n");
      if (index < 0) return rest;
      const line = rest.slice(0, index).trim();
      rest = rest.slice(index + 1);
      if (line !== "") onLine(line);
    }
  }
  function emitLine(line, sink) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (isRecord2(parsed)) sink(parsed);
  }
  async function readNdjson(response, sink) {
    const stream = response.body;
    const readerHost = stream !== null && typeof stream === "object" && "getReader" in stream ? stream : null;
    if (readerHost !== null && typeof readerHost.getReader === "function") {
      const reader = readerHost.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (; ; ) {
        const chunk = await reader.read();
        if (chunk.value !== void 0) buffer += decoder.decode(chunk.value, { stream: true });
        buffer = drainLines(buffer, (line) => {
          emitLine(line, sink);
        });
        if (chunk.done === true) break;
      }
      buffer += decoder.decode();
      const tail = buffer.trim();
      if (tail !== "") emitLine(tail, sink);
      return;
    }
    const text = await response.text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed !== "") emitLine(trimmed, sink);
    }
  }
  function buildView(doc, options) {
    ensureStyle2(doc);
    const overlay = element(doc, "div", "dshu-overlay");
    overlay.setAttribute(PANEL_MARK, "");
    const panel = element(doc, "div", "dshu-panel");
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "DSH \u5347\u7EA7");
    const head = element(doc, "div", "dshu-head");
    const title = element(doc, "span", "dshu-title", "DSH \u5347\u7EA7");
    const closeButton = buttonOf(doc, "dshu-close", "\xD7");
    closeButton.setAttribute("aria-label", "\u5173\u95ED");
    head.append(title, closeButton);
    const hostSection = element(doc, "section", "dshu-section");
    hostSection.setAttribute("data-k", "host");
    const hostTitle = doc.createElement("h3");
    hostTitle.textContent = "\u672C\u4F53";
    const hostVersions = element(doc, "div", "dshu-versions");
    const hostActions = element(doc, "div", "dshu-host-actions");
    const hostBar = element(doc, "div", "dshu-host-bar");
    hostBar.hidden = true;
    const hostFill = element(doc, "div", "dshu-bar-fill");
    hostBar.appendChild(hostFill);
    const releaseBox = element(doc, "div", "dshu-release");
    releaseBox.hidden = true;
    const hostRow = element(doc, "div", "dshu-row");
    const toggleLabel = element(doc, "label", "dshu-toggle");
    const prerelease = doc.createElement("input");
    prerelease.type = "checkbox";
    prerelease.className = "dshu-prerelease";
    toggleLabel.append(prerelease, doc.createTextNode("\u663E\u793A\u9884\u53D1\u5E03\u7248\u672C"));
    const refreshButton = buttonOf(doc, "dshu-refresh", "\u91CD\u65B0\u68C0\u67E5");
    hostRow.append(toggleLabel, refreshButton);
    hostSection.append(hostTitle, hostVersions, hostBar, hostActions, releaseBox, hostRow);
    const pluginsSection = element(doc, "section", "dshu-section");
    pluginsSection.setAttribute("data-k", "plugins");
    const pluginsHead = element(doc, "div", "dshu-plugins-head");
    const pluginHead = doc.createElement("h3");
    pluginHead.className = "dshu-plugin-head";
    pluginHead.textContent = "\u63D2\u4EF6";
    const upgradeAllButton = buttonOf(doc, "dshu-upgrade-all", "\u5168\u90E8\u5347\u7EA7");
    const restartButton = buttonOf(doc, "dshu-restart", "\u91CD\u542F DSH");
    restartButton.hidden = true;
    pluginsHead.append(pluginHead, upgradeAllButton, restartButton);
    const pluginList = element(doc, "div", "dshu-plugin-list");
    const pluginSummary = element(doc, "div", "dshu-plugin-summary");
    pluginSummary.hidden = true;
    pluginsSection.append(pluginsHead, pluginList, pluginSummary);
    const progress = element(doc, "div", "dshu-progress");
    progress.hidden = true;
    const notice = element(doc, "div", "dshu-notice");
    notice.hidden = true;
    const body = element(doc, "div", "dshu-body");
    body.append(hostSection, pluginsSection, progress, notice);
    panel.append(head, body);
    overlay.appendChild(panel);
    const view = {
      doc,
      options,
      overlay,
      panel,
      body,
      hostSection,
      pluginsSection,
      hostVersions,
      hostActions,
      releaseBox,
      hostBar,
      hostFill,
      pluginHead,
      pluginList,
      rows: /* @__PURE__ */ new Map(),
      retryNames: [],
      upgradeAllButton,
      restartButton,
      restartArmed: false,
      restartArmedAt: null,
      restartRunning: false,
      pluginSummary,
      progress,
      notice,
      prerelease,
      refreshButton,
      upgradeButton: null,
      error: null,
      survey: null,
      plugins: null,
      includePrerelease: false,
      upgradeBusy: false,
      batchBusy: false,
      token: 1,
      closed: false,
      previousOverflow: "",
      focusBefore: doc.activeElement,
      onKeydown: () => {
      }
    };
    view.onKeydown = (event) => {
      if (event.key === "Escape") close(view);
    };
    closeButton.addEventListener("click", () => {
      close(view);
    });
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close(view);
    });
    upgradeAllButton.addEventListener("click", () => {
      void startBatch(view);
    });
    restartButton.addEventListener("click", () => {
      if (view.batchBusy || view.upgradeBusy || view.restartRunning || restartButton.disabled) return;
      if (view.restartArmedAt !== null && Date.now() - view.restartArmedAt < CONFIRM_COOLDOWN_MS) return;
      if (!view.restartArmed) {
        view.restartArmed = true;
        view.restartArmedAt = Date.now();
        restartButton.textContent = "\u786E\u8BA4\u91CD\u542F\uFF1F";
        setNotice(view, "\u91CD\u542F\u4F1A\u4E2D\u65AD\u5F53\u524D\u4F1A\u8BDD\uFF1B\u518D\u70B9\u4E00\u6B21\u300C\u786E\u8BA4\u91CD\u542F\uFF1F\u300D\u7EE7\u7EED");
        return;
      }
      view.restartArmed = false;
      view.restartArmedAt = null;
      view.restartRunning = true;
      setRestartBusy(view, true);
      restartButton.textContent = "\u91CD\u542F\u4E2D\u2026";
      restartButton.disabled = true;
      view.progress.textContent = "";
      view.progress.hidden = true;
      const token = view.token;
      void runRestartChain(view, token, (reason) => {
        if (!live(view, token)) return;
        setRestartBusy(view, false);
        restartButton.disabled = false;
        restartButton.textContent = "\u91CD\u542F DSH";
        setNotice(view, "\u91CD\u542F\u4E0D\u53EF\u7528\uFF1A" + reason);
      });
    });
    prerelease.addEventListener("change", () => {
      if (view.upgradeBusy || view.batchBusy) return;
      disarmRestart(view);
      const token = view.token;
      view.includePrerelease = prerelease.checked;
      void loadHost(view, token, { check: true, force: false });
    });
    refreshButton.addEventListener("click", () => {
      if (view.upgradeBusy || view.batchBusy) return;
      disarmRestart(view);
      const token = view.token;
      view.includePrerelease = prerelease.checked;
      void loadHost(view, token, { check: true, force: true });
    });
    return view;
  }
  function close(view) {
    if (view.closed) return;
    view.closed = true;
    view.token += 1;
    view.doc.removeEventListener("keydown", view.onKeydown);
    view.overlay.remove();
    view.doc.body.style.overflow = view.previousOverflow;
    if (activeViews.get(view.doc) === view) activeViews.delete(view.doc);
    if (lastView === view) lastView = null;
    const focusBefore = view.focusBefore;
    if (focusBefore !== null && typeof focusBefore.focus === "function" && focusBefore.isConnected) {
      try {
        ;
        focusBefore.focus();
      } catch {
      }
    }
    try {
      view.options.onClose?.();
    } catch {
    }
  }
  var lastView = null;
  function emitState(view) {
    const hostUpdate = hasHostUpdate(view.survey);
    const pluginUpdate = view.plugins !== null && view.plugins.available && view.plugins.updatable.length > 0;
    try {
      view.options.onState?.({ hasUpdate: hostUpdate || pluginUpdate, busy: view.upgradeBusy || view.batchBusy });
    } catch {
    }
  }
  function showError(view, text) {
    if (view.error === null) {
      const bar = element(view.doc, "div", "dshu-error");
      bar.setAttribute("role", "alert");
      view.body.insertBefore(bar, view.progress);
      view.error = bar;
    }
    view.error.textContent = text;
  }
  function clearError(view) {
    if (view.error === null) return;
    view.error.remove();
    view.error = null;
  }
  function setNotice(view, text) {
    if (text === "") {
      view.notice.hidden = true;
      view.notice.textContent = "";
      return;
    }
    view.notice.hidden = false;
    view.notice.textContent = text;
  }
  function disarmRestart(view) {
    view.restartArmedAt = null;
    if (!view.restartArmed) return;
    view.restartArmed = false;
    view.restartButton.textContent = "\u91CD\u542F DSH";
  }
  function resetProgress(view) {
    view.progress.textContent = "";
    view.progress.hidden = false;
  }
  function addProgress(view, text) {
    view.progress.hidden = false;
    const line = element(view.doc, "div", "dshu-progress-line", text);
    view.progress.appendChild(line);
  }
  function setHostProgress(view, phase) {
    view.hostBar.hidden = false;
    const index = HOST_PHASES.indexOf(phase);
    if (index < 0) {
      view.hostBar.setAttribute("data-indeterminate", "");
      view.hostFill.style.width = "";
      return;
    }
    view.hostBar.removeAttribute("data-indeterminate");
    view.hostFill.style.width = String(Math.round((index + 1) / HOST_PHASES.length * 100)) + "%";
  }
  function hideHostProgress(view) {
    view.hostBar.hidden = true;
    view.hostBar.removeAttribute("data-indeterminate");
    view.hostFill.style.width = "0";
  }
  function renderSurvey(view) {
    const doc = view.doc;
    view.hostVersions.textContent = "";
    view.releaseBox.textContent = "";
    view.releaseBox.hidden = true;
    if (view.upgradeButton !== null) {
      view.upgradeButton.remove();
      view.upgradeButton = null;
    }
    const survey = view.survey;
    if (survey === null) {
      view.hostVersions.appendChild(element(doc, "span", "dshu-version", "\u8BFB\u4E0D\u5230\u7248\u672C\u72B6\u6001"));
      return;
    }
    if (survey.restartRequired) {
      view.hostVersions.appendChild(
        element(
          doc,
          "span",
          "dshu-current dshu-restart-required",
          "\u5DF2\u5347\u7EA7\u5230 " + survey.current + "\uFF0C\u9700\u91CD\u542F dsh web \u624D\u751F\u6548"
        )
      );
    }
    if (!hasNewerTarget(survey)) {
      if (!survey.restartRequired) {
        view.hostVersions.appendChild(
          element(doc, "span", "dshu-current", "\u5DF2\u662F\u6700\u65B0\uFF08\u5F53\u524D " + survey.current + "\uFF09")
        );
      }
      return;
    }
    const target = survey.target;
    view.hostVersions.append(
      element(doc, "span", "dshu-version dshu-current", "\u5F53\u524D " + survey.current),
      element(doc, "span", "dshu-arrow", "\u2192"),
      element(doc, "span", "dshu-version dshu-target", "\u76EE\u6807 " + target)
    );
    const channel = channelOf(survey, target);
    if (channel !== "") {
      view.hostVersions.appendChild(element(doc, "span", "dshu-channel", channel + " \u901A\u9053"));
    }
    const upgrade = buttonOf(doc, "dshu-upgrade-btn", "\u5347\u7EA7\u5230 " + target);
    if (survey.blocked !== null) {
      upgrade.disabled = true;
      upgrade.setAttribute("data-blocked", "");
      upgrade.textContent = survey.blocked.message !== "" ? survey.blocked.message : "\u9700\u8981 Node\uFF08\u672C\u673A\u7248\u672C\u4E0D\u6EE1\u8DB3\uFF09";
      upgrade.title = survey.blocked.code;
    } else {
      upgrade.disabled = view.batchBusy || view.upgradeBusy;
      upgrade.addEventListener("click", () => {
        void runHostUpgrade(view, view.token);
      });
    }
    view.hostActions.appendChild(upgrade);
    view.upgradeButton = upgrade;
  }
  function releaseTagUrl(target) {
    return RELEASE_PAGE + encodeURIComponent(target);
  }
  function isHttpUrl(url) {
    return /^https?:\/\//i.test(url);
  }
  function renderReleases(view, reply) {
    const doc = view.doc;
    const box = view.releaseBox;
    box.textContent = "";
    const survey = view.survey;
    if (survey === null || !hasNewerTarget(survey)) {
      box.hidden = true;
      return;
    }
    if (reply.degraded) {
      box.hidden = false;
      const hint = element(doc, "div", "dshu-release-hint", "\u66F4\u65B0\u5185\u5BB9\u62C9\u53D6\u5931\u8D25");
      const link = doc.createElement("a");
      link.className = "dshu-release-link";
      link.href = releaseTagUrl(survey.target);
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "\u53BB GitHub \u770B";
      hint.appendChild(link);
      box.appendChild(hint);
      return;
    }
    if (reply.releases.length === 0) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    for (const [index, release] of reply.releases.entries()) {
      const row = element(doc, "div", "dshu-release-row");
      const toggle = buttonOf(doc, "dshu-release-toggle", releaseTitle(release));
      toggle.setAttribute("aria-expanded", index === 0 ? "true" : "false");
      const body = element(doc, "div", "dshu-release-body");
      body.hidden = index !== 0;
      const list = doc.createElement("ul");
      list.className = "dshu-release-items";
      if (release.items.length === 0) {
        const item = doc.createElement("li");
        item.textContent = "\u8BE5\u7248\u672C\u6CA1\u6709\u5217\u51FA\u66F4\u65B0\u6761\u76EE";
        list.appendChild(item);
      }
      for (const text of release.items) {
        const item = doc.createElement("li");
        item.textContent = text;
        list.appendChild(item);
      }
      body.appendChild(list);
      if (release.url !== "" && isHttpUrl(release.url)) {
        const link = doc.createElement("a");
        link.className = "dshu-release-link";
        link.href = release.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "\u770B\u8FD9\u6B21\u53D1\u5E03";
        body.appendChild(link);
      }
      toggle.addEventListener("click", () => {
        body.hidden = !body.hidden;
        toggle.setAttribute("aria-expanded", body.hidden ? "false" : "true");
      });
      row.append(toggle, body);
      box.appendChild(row);
    }
  }
  function paintPluginsHead(view) {
    const plugins = view.plugins;
    if (plugins === null || !plugins.available || plugins.updatable.length === 0) {
      view.pluginHead.textContent = "\u63D2\u4EF6";
      view.upgradeAllButton.hidden = true;
      return;
    }
    view.pluginHead.textContent = "\u63D2\u4EF6\uFF08" + plugins.updatable.length + " \u4E2A\u53EF\u66F4\u65B0\uFF09";
    view.upgradeAllButton.hidden = false;
    view.upgradeAllButton.textContent = view.retryNames.length > 0 ? "\u7EE7\u7EED\u5347\u7EA7" : "\u5168\u90E8\u5347\u7EA7";
  }
  function renderPlugins(view) {
    const doc = view.doc;
    view.pluginList.textContent = "";
    view.rows.clear();
    view.retryNames = [];
    view.pluginSummary.hidden = true;
    view.pluginSummary.textContent = "";
    const plugins = view.plugins;
    if (plugins === null) {
      paintPluginsHead(view);
      return;
    }
    if (!plugins.available) {
      paintPluginsHead(view);
      view.pluginList.appendChild(element(doc, "div", "dshu-plugin-unavailable", "\u63D2\u4EF6\u66F4\u65B0\u4E0D\u53EF\u7528"));
      return;
    }
    paintPluginsHead(view);
    if (plugins.updatable.length === 0) {
      view.pluginList.appendChild(element(doc, "div", "dshu-plugin-empty", "\u5DF2\u662F\u6700\u65B0"));
      return;
    }
    for (const update of plugins.updatable) {
      const row = createPluginRow(view, update);
      view.rows.set(update.name, row);
      view.pluginList.appendChild(row.root);
    }
  }
  function createPluginRow(view, update) {
    const doc = view.doc;
    const root = element(doc, "div", "dshu-plugin");
    root.dataset.name = update.name;
    const line = element(doc, "div", "dshu-plugin-line");
    const name = element(doc, "div", "dshu-plugin-name", update.name);
    const version = element(doc, "div", "dshu-plugin-version", update.from + " \u2192 " + update.to);
    line.append(name, version);
    const state = element(doc, "div", "dshu-plugin-state");
    const progress = element(doc, "div", "dshu-plugin-progress");
    progress.hidden = true;
    const bar = element(doc, "div", "dshu-bar");
    bar.hidden = true;
    const fill = element(doc, "div", "dshu-bar-fill");
    bar.appendChild(fill);
    const progressText = element(doc, "div", "dshu-plugin-progress-text");
    progress.append(bar, progressText);
    root.append(line, state, progress);
    return { root, name, version, state, bar, fill, progress, progressText };
  }
  function setRowState(row, text, isError = false, full) {
    row.state.textContent = text;
    row.state.title = full ?? "";
    row.state.hidden = text === "";
    if (isError) row.state.setAttribute("data-error", "");
    else row.state.removeAttribute("data-error");
  }
  function compactReason(raw, limit = 90) {
    const zh = raw.split(" / ")[0] ?? raw;
    const flat = zh.replace(/\s+/g, " ").trim();
    if (flat === "") return "";
    if (flat.length <= limit) return flat;
    return flat.slice(0, limit - 1) + "\u2026";
  }
  function setRowProgress(row, percent, visible) {
    row.progress.hidden = !visible;
    row.bar.hidden = !visible;
    if (!visible) {
      row.bar.removeAttribute("data-indeterminate");
      row.fill.style.width = "0";
      return;
    }
    if (percent === null) {
      row.bar.setAttribute("data-indeterminate", "");
      row.fill.style.width = "";
      return;
    }
    row.bar.removeAttribute("data-indeterminate");
    row.fill.style.width = String(percent) + "%";
  }
  function paintBatchItem(row, item) {
    switch (item.state) {
      case "pending":
        setRowState(row, "");
        row.progressText.textContent = "";
        setRowProgress(row, null, false);
        return;
      case "running": {
        const percent = item.percent;
        setRowState(row, "");
        row.progressText.textContent = item.message ?? (item.detail !== null ? compactReason(item.detail) : percent !== null ? "\u6B63\u5728\u5347\u7EA7\u2026" + String(percent) + "%" : "\u6B63\u5728\u5347\u7EA7\u2026");
        setRowProgress(row, percent, true);
        return;
      }
      case "succeeded":
        setRowState(row, "\u5DF2\u5347\u7EA7");
        row.progressText.textContent = "";
        setRowProgress(row, null, false);
        return;
      case "failed": {
        row.progressText.textContent = "";
        setRowProgress(row, null, false);
        if (item.unavailable) {
          setRowState(row, item.message ?? "\u63D2\u4EF6\u66F4\u65B0\u4E0D\u53EF\u7528");
          return;
        }
        const message = item.message;
        const stalled = message !== null && (message.startsWith("\u8FD8\u6CA1\u5F00\u59CB\u5347\u7EA7") || message.startsWith("\u5347\u7EA7\u8FD8\u5728\u540E\u53F0\u8DD1") || message.startsWith("\u4E00\u76F4\u5728\u6392\u961F"));
        const complete = message !== null && (message.startsWith("\u5347\u7EA7\u5931\u8D25") || message.startsWith("\u5DF2") || message === "\u63D2\u4EF6\u66F4\u65B0\u4E0D\u53EF\u7528" || stalled);
        const text = message === null || message === "" ? "\u5347\u7EA7\u5931\u8D25" : complete ? compactReason(message) : "\u5347\u7EA7\u5931\u8D25\uFF1A" + compactReason(message);
        setRowState(row, text, !stalled, message ?? void 0);
        return;
      }
    }
  }
  function paintSkipped(row) {
    setRowState(row, "\u5DF2\u8DF3\u8FC7");
    row.progressText.textContent = "";
    setRowProgress(row, null, false);
  }
  function batchSummaryText(summary) {
    const parts = [];
    if (summary.succeeded.length > 0) parts.push(String(summary.succeeded.length) + " \u4E2A\u5DF2\u5347\u7EA7");
    if (summary.failed.length > 0) parts.push(String(summary.failed.length) + " \u4E2A\u5931\u8D25");
    if (summary.skipped.length > 0) parts.push(String(summary.skipped.length) + " \u4E2A\u8DF3\u8FC7");
    if (summary.restartRequired && summary.succeeded.length > 0) parts.push("\u9700\u91CD\u542F\u751F\u6548");
    return parts.join("\uFF0C");
  }
  function hostUpgradeDisabled(view) {
    return view.survey === null || view.survey.blocked !== null || !hasNewerTarget(view.survey) || view.batchBusy || view.upgradeBusy || view.restartRunning;
  }
  function setBatchBusy(view, busy) {
    view.batchBusy = busy;
    view.upgradeAllButton.disabled = busy || view.upgradeBusy || view.restartRunning;
    view.upgradeAllButton.textContent = busy ? "\u5347\u7EA7\u4E2D\u2026" : view.retryNames.length > 0 ? "\u7EE7\u7EED\u5347\u7EA7" : "\u5168\u90E8\u5347\u7EA7";
    view.prerelease.disabled = busy || view.upgradeBusy || view.restartRunning;
    view.refreshButton.disabled = busy || view.upgradeBusy || view.restartRunning;
    if (view.upgradeButton !== null) {
      if (busy) {
        view.upgradeButton.disabled = true;
      } else {
        view.upgradeButton.disabled = hostUpgradeDisabled(view);
      }
    }
    emitState(view);
  }
  function setRestartBusy(view, busy) {
    view.restartRunning = busy;
    const blocked = busy || view.batchBusy || view.upgradeBusy;
    view.upgradeAllButton.disabled = blocked;
    view.prerelease.disabled = blocked;
    view.refreshButton.disabled = blocked;
    if (view.upgradeButton !== null) {
      view.upgradeButton.disabled = busy ? true : hostUpgradeDisabled(view);
    }
    emitState(view);
  }
  async function startBatch(view) {
    if (view.batchBusy || view.upgradeBusy || view.restartRunning) return;
    const plugins = view.plugins;
    if (plugins === null || !plugins.available) return;
    const names = view.retryNames.length > 0 ? view.retryNames.slice() : plugins.updatable.map((update) => update.name);
    if (names.length === 0) return;
    const token = view.token;
    for (const [name, row] of view.rows) {
      paintBatchItem(row, { name, state: "pending", percent: null, detail: null, message: null, unavailable: false });
    }
    setBatchBusy(view, true);
    view.pluginSummary.hidden = true;
    view.pluginSummary.textContent = "";
    view.restartButton.hidden = true;
    view.restartButton.disabled = false;
    disarmRestart(view);
    let summary;
    try {
      summary = await runBatch(names, fetchOf(view.doc), view.options.apiBase ?? "", {
        pollIntervalMs: view.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        stalledWaitMs: view.options.stalledWaitMs ?? DEFAULT_STALLED_WAIT_MS,
        cancelled: () => view.closed,
        onEvent: (event) => {
          if (!live(view, token)) return;
          const row = view.rows.get(event.item.name);
          if (row !== void 0) paintBatchItem(row, event.item);
        }
      });
    } catch (error) {
      if (!live(view, token)) return;
      setBatchBusy(view, false);
      paintSummary(view, "\u5347\u7EA7\u4E2D\u65AD\uFF1A" + (error instanceof Error && error.message !== "" ? error.message : "\u672A\u77E5\u539F\u56E0"));
      return;
    }
    if (!live(view, token)) return;
    const done = new Set(summary.succeeded);
    if (done.size > 0) {
      plugins.updatable = plugins.updatable.filter((update) => !done.has(update.name));
    }
    view.retryNames = [...summary.failed, ...summary.skipped];
    setBatchBusy(view, false);
    paintSummary(view, batchSummaryText(summary));
    for (const name of summary.skipped) {
      const row = view.rows.get(name);
      if (row !== void 0) paintSkipped(row);
    }
    paintPluginsHead(view);
    if (summary.succeeded.length > 0) await offerRestart(view, token);
  }
  function paintSummary(view, text) {
    view.pluginSummary.textContent = text;
    view.pluginSummary.hidden = text === "";
  }
  async function loadHost(view, token, mode) {
    const f = fetchOf(view.doc);
    const base = view.options.apiBase ?? "";
    try {
      let reply;
      if (mode === "status") {
        reply = await requestJson(f, joinUrl(base, STATUS_PATH), {
          method: "GET",
          credentials: "same-origin",
          headers: { ...HOST_HEADERS }
        });
      } else {
        reply = await requestJson(f, joinUrl(base, CHECK_PATH), {
          method: "POST",
          credentials: "same-origin",
          headers: { ...HOST_HEADERS, "content-type": "application/json" },
          body: JSON.stringify({ includePrerelease: view.includePrerelease, force: mode.force })
        });
      }
      if (!live(view, token)) return;
      if (!reply.ok) {
        if (view.survey === null) {
          renderSurvey(view);
          emitState(view);
        }
        showError(view, "\u8BFB\u53D6\u7248\u672C\u72B6\u6001\u5931\u8D25\uFF08HTTP " + reply.status + "\uFF09");
        return;
      }
      const survey = normalizeSurvey(reply.body);
      view.survey = survey;
      clearError(view);
      renderSurvey(view);
      emitState(view);
      if (!live(view, token)) return;
      if (!hasNewerTarget(survey)) return;
      const releases = await requestJson(
        f,
        joinUrl(base, RELEASES_PATH) + "?from=" + encodeURIComponent(survey === null ? "" : survey.current) + "&to=" + encodeURIComponent(survey === null ? "" : survey.target),
        { method: "GET", credentials: "same-origin", headers: { ...HOST_HEADERS } }
      );
      if (!live(view, token)) return;
      renderReleases(view, releases.ok ? normalizeReleases(releases.body) : { releases: [], degraded: true });
    } catch {
      if (!live(view, token)) return;
      showError(view, "\u8BFB\u53D6\u7248\u672C\u72B6\u6001\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
    }
  }
  async function loadPlugins(view, token) {
    if (view.batchBusy) return;
    const base = view.options.apiBase ?? "";
    try {
      const plugins = await fetchPluginUpdates(fetchOf(view.doc), base);
      if (!live(view, token)) return;
      view.plugins = plugins;
      renderPlugins(view);
      emitState(view);
    } catch {
      if (!live(view, token)) return;
      view.plugins = { available: false, updatable: [] };
      renderPlugins(view);
      emitState(view);
    }
  }
  async function runHostUpgrade(view, token) {
    const survey = view.survey;
    if (survey === null || !hasNewerTarget(survey) || view.upgradeBusy || view.batchBusy || view.restartRunning) return;
    const target = survey.target;
    const f = fetchOf(view.doc);
    const base = view.options.apiBase ?? "";
    disarmRestart(view);
    view.upgradeBusy = true;
    if (view.upgradeButton !== null) view.upgradeButton.disabled = true;
    view.prerelease.disabled = true;
    view.refreshButton.disabled = true;
    view.upgradeAllButton.disabled = true;
    clearError(view);
    setNotice(view, "");
    resetProgress(view);
    emitState(view);
    try {
      const response = await f(joinUrl(base, UPGRADE_PATH), {
        method: "POST",
        credentials: "same-origin",
        headers: { ...HOST_HEADERS, "content-type": "application/json" },
        body: JSON.stringify({ target })
      });
      if (!live(view, token)) return;
      if (!response.ok) {
        const body = await readJsonBody2(response);
        if (!live(view, token)) return;
        const code = isRecord2(body) ? asString(body.code) : "";
        const message = isRecord2(body) ? asString(body.message) : "";
        if (response.status === 409 || code === "BUSY") {
          setNotice(view, message !== "" ? message : "\u5DF2\u6709\u4E00\u8F6E\u5347\u7EA7\u5728\u8FDB\u884C");
        } else {
          showError(view, message !== "" ? message : "\u5347\u7EA7\u8BF7\u6C42\u5931\u8D25\uFF08HTTP " + response.status + "\uFF09");
        }
        finishHostBusy(view);
        return;
      }
      await consumeUpgrade(view, token, response, target);
      finishHostBusy(view);
    } catch {
      if (!live(view, token)) return;
      showError(view, "\u5347\u7EA7\u8BF7\u6C42\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u7F51\u7EDC\u540E\u91CD\u8BD5");
      finishHostBusy(view);
    }
  }
  function finishHostBusy(view) {
    hideHostProgress(view);
    view.upgradeBusy = false;
    view.prerelease.disabled = view.batchBusy;
    view.refreshButton.disabled = view.batchBusy;
    view.upgradeAllButton.disabled = view.batchBusy;
    if (view.upgradeButton !== null) {
      const blocked = view.survey !== null && view.survey.blocked !== null;
      view.upgradeButton.disabled = blocked || !hasNewerTarget(view.survey);
    }
    emitState(view);
  }
  async function consumeUpgrade(view, token, response, target) {
    let sawDone = false;
    let failure = null;
    try {
      await readNdjson(response, (event) => {
        if (!live(view, token)) return;
        const phase = asString(event.phase);
        const message = asString(event.message);
        if (phase === "fail" || event.error !== void 0 && event.error !== null) {
          failure = failureTextOf(event);
          return;
        }
        if (event.done === true) sawDone = true;
        if (phase !== "") setHostProgress(view, phase);
        if (phase === "done") {
          addProgress(view, phaseLabel("done"));
          return;
        }
        addProgress(view, message !== "" ? phaseLabel(phase) + "\uFF1A" + message : phaseLabel(phase));
      });
    } catch {
      if (!live(view, token)) return;
      hideHostProgress(view);
      showError(view, "\u5347\u7EA7\u8FDB\u5EA6\u8BFB\u5230\u4E00\u534A\u65AD\u4E86\uFF0C\u8BF7\u5237\u65B0\u540E\u786E\u8BA4\u7ED3\u679C");
      return;
    }
    if (!live(view, token)) return;
    if (failure !== null) {
      hideHostProgress(view);
      showError(view, failure);
      return;
    }
    if (!sawDone) {
      hideHostProgress(view);
      showError(view, "\u5347\u7EA7\u6CA1\u6709\u6B63\u5E38\u7ED3\u675F\uFF0C\u8BF7\u5237\u65B0\u540E\u786E\u8BA4\u7ED3\u679C");
      return;
    }
    addProgress(view, "\u5DF2\u5347\u7EA7\u5230 " + target);
    await continueToRestart(view, token, target);
  }
  function restartFailureDetail(event) {
    const stage = asString(event.stage);
    const label = stage === "" ? "" : RESTART_STAGE_LABELS[stage] ?? stage;
    let message = "";
    if (Array.isArray(event.failures)) {
      for (const failure of event.failures) {
        if (!isRecord2(failure)) continue;
        message = compactReason(asString(failure.message));
        if (message !== "") break;
      }
    }
    if (message === "") message = compactReason(asString(event.message));
    if (message === "") return label;
    return label === "" ? message : label + "\uFF1A" + message;
  }
  async function readFailureReason(response) {
    try {
      const text = (await response.text()).trim();
      if (text === "") return "";
      try {
        const parsed = JSON.parse(text);
        if (isRecord2(parsed)) {
          const error = asString(parsed.error);
          if (error !== "") return compactReason(error);
          const message = asString(parsed.message);
          if (message !== "") return compactReason(message);
        }
      } catch {
      }
      return compactReason(text);
    } catch {
      return "";
    }
  }
  async function runRestartChain(view, token, onManual, successText = "\u6B63\u5728\u91CD\u542F\u2026") {
    const f = fetchOf(view.doc);
    const base = view.options.apiBase ?? "";
    let status;
    try {
      status = await f(joinUrl(base, RESTART_STATUS_PATH), {
        method: "GET",
        credentials: "same-origin",
        headers: { ...RESTART_HEADERS }
      });
    } catch {
      if (live(view, token)) onManual("\u8FDE\u4E0D\u4E0A dsh-restart");
      return;
    }
    if (!live(view, token)) return;
    if (!status.ok) {
      onManual(
        status.status === 404 ? "\u6CA1\u627E\u5230 dsh-restart" : status.status === 401 || status.status === 403 ? "dsh-restart \u62D2\u7EDD\u8BBF\u95EE\uFF08HTTP " + status.status + "\uFF09" : "dsh-restart \u72B6\u6001\u67E5\u8BE2\u5931\u8D25\uFF08HTTP " + status.status + "\uFF09"
      );
      return;
    }
    setNotice(view, "\u6B63\u5728\u9884\u68C0\u2026");
    let precheck;
    try {
      precheck = await f(joinUrl(base, RESTART_PRECHECK_PATH), {
        method: "POST",
        credentials: "same-origin",
        headers: { ...RESTART_HEADERS }
      });
    } catch {
      if (live(view, token)) onManual("\u9884\u68C0\u8BF7\u6C42\u53D1\u4E0D\u51FA\u53BB");
      return;
    }
    if (!live(view, token)) return;
    if (!precheck.ok) {
      const reason = await readFailureReason(precheck);
      if (!live(view, token)) return;
      onManual("\u9884\u68C0\u5931\u8D25\uFF08HTTP " + precheck.status + (reason === "" ? "" : "\uFF1A" + reason) + "\uFF09");
      return;
    }
    let failed = false;
    let sawDone = false;
    let detail = "";
    try {
      await readNdjson(precheck, (event) => {
        if (!live(view, token)) return;
        if (event.ok === false) {
          failed = true;
          if (detail === "") detail = restartFailureDetail(event);
        }
        if (event.error !== void 0 && event.error !== null) {
          failed = true;
          if (detail === "") {
            detail = compactReason(
              isRecord2(event.error) ? asString(event.error.message) : asString(event.error)
            );
          }
        }
        const stage = asString(event.stage);
        if (stage !== "") {
          setNotice(
            view,
            "\u91CD\u542F\u9884\u68C0\uFF1A" + (RESTART_STAGE_LABELS[stage] ?? stage) + (event.ok === false ? "\uFF08\u672A\u901A\u8FC7\uFF09" : "\uFF08\u901A\u8FC7\uFF09")
          );
          return;
        }
        if (event.done === true) {
          sawDone = true;
          if (!failed && event.ok !== false) setNotice(view, "\u91CD\u542F\u9884\u68C0\u5B8C\u6210");
        }
      });
    } catch {
      if (live(view, token)) onManual("\u9884\u68C0\u8BFB\u5230\u4E00\u534A\u65AD\u4E86");
      return;
    }
    if (!live(view, token)) return;
    if (failed) {
      onManual("\u9884\u68C0\u6CA1\u901A\u8FC7" + (detail === "" ? "" : "\uFF1A" + detail));
      return;
    }
    if (!sawDone) {
      onManual("\u9884\u68C0\u6CA1\u6709\u8FD4\u56DE\u7ED3\u679C\uFF0C\u672A\u91CD\u542F");
      return;
    }
    let restart;
    try {
      restart = await f(joinUrl(base, RESTART_PATH), {
        method: "POST",
        credentials: "same-origin",
        headers: { ...RESTART_HEADERS }
      });
    } catch {
      if (live(view, token)) onManual("\u91CD\u542F\u8BF7\u6C42\u53D1\u4E0D\u51FA\u53BB");
      return;
    }
    if (!live(view, token)) return;
    if (restart.status === 409) {
      onManual("\u5DF2\u7ECF\u6709\u4E00\u8F6E\u91CD\u542F\u5728\u8FDB\u884C\uFF0C\u8BF7\u7A0D\u540E\u624B\u52A8\u5237\u65B0\u9875\u9762\u786E\u8BA4");
      return;
    }
    if (!restart.ok) {
      onManual("\u91CD\u542F\u8BF7\u6C42\u5931\u8D25\uFF08HTTP " + restart.status + "\uFF09");
      return;
    }
    setNotice(view, successText);
    close(view);
  }
  async function continueToRestart(view, token, target) {
    await runRestartChain(
      view,
      token,
      (reason) => {
        setNotice(view, "\u5DF2\u5347\u7EA7\u5230 " + target + "\uFF0C" + reason + "\uFF0C\u9700\u624B\u52A8\u91CD\u542F");
      },
      "\u5DF2\u5347\u7EA7\u5230 " + target + "\uFF0C\u6B63\u5728\u91CD\u542F\u2026"
    );
  }
  async function offerRestart(view, token) {
    view.restartButton.hidden = true;
    view.restartButton.disabled = false;
    view.restartButton.textContent = "\u91CD\u542F DSH";
    view.restartArmed = false;
    const f = fetchOf(view.doc);
    const base = view.options.apiBase ?? "";
    let status;
    try {
      status = await f(joinUrl(base, RESTART_STATUS_PATH), {
        method: "GET",
        credentials: "same-origin",
        headers: { ...RESTART_HEADERS }
      });
    } catch {
      if (!live(view, token) || view.batchBusy) return;
      setNotice(view, "\u63D2\u4EF6\u5DF2\u5347\u7EA7\uFF0C\u8FDE\u4E0D\u4E0A dsh-restart\uFF0C\u9700\u624B\u52A8\u91CD\u542F dsh web \u624D\u751F\u6548");
      return;
    }
    if (!live(view, token) || view.batchBusy) return;
    if (status.status === 200) {
      view.restartButton.hidden = false;
      setNotice(view, "\u63D2\u4EF6\u5DF2\u5347\u7EA7\uFF0C\u53EF\u70B9\u300C\u91CD\u542F DSH\u300D\u8BA9\u6539\u52A8\u751F\u6548");
      return;
    }
    if (status.status === 404) {
      setNotice(view, "\u63D2\u4EF6\u5DF2\u5347\u7EA7\uFF0C\u9700\u624B\u52A8\u91CD\u542F dsh web \u624D\u751F\u6548");
      return;
    }
    setNotice(view, "\u63D2\u4EF6\u5DF2\u5347\u7EA7\uFF0C\u4F46\u91CD\u542F\u4E0D\u53EF\u7528\uFF08HTTP " + status.status + "\uFF09\uFF0C\u9700\u624B\u52A8\u91CD\u542F dsh web");
  }
  async function openPanel(doc, opts = {}) {
    if (activeViews.get(doc) !== void 0) return;
    if (doc.querySelector("[" + PANEL_MARK + "]") !== null) return;
    const view = buildView(doc, opts);
    const body = doc.body;
    view.previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";
    body.appendChild(view.overlay);
    activeViews.set(doc, view);
    lastView = view;
    doc.addEventListener("keydown", view.onKeydown);
    const token = view.token;
    emitState(view);
    try {
      await Promise.all([loadHost(view, token, "status"), loadPlugins(view, token)]);
    } catch {
      if (live(view, token)) showError(view, "\u52A0\u8F7D\u5347\u7EA7\u4FE1\u606F\u5931\u8D25\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5");
    }
  }
  async function probeEntryState(doc, opts = {}) {
    const f = fetchOf(doc);
    const base = opts.apiBase ?? "";
    try {
      const [reply, plugins] = await Promise.all([
        requestJson(f, joinUrl(base, STATUS_PATH), {
          method: "GET",
          credentials: "same-origin",
          headers: { ...HOST_HEADERS }
        }).catch(() => null),
        fetchPluginUpdates(f, base).catch(() => null)
      ]);
      const survey = reply !== null && reply.ok ? normalizeSurvey(reply.body) : null;
      const hostUpdate = hasHostUpdate(survey);
      const pluginUpdate = plugins !== null && plugins.available && plugins.updatable.length > 0;
      const known = reply !== null && reply.ok && plugins !== null;
      return { hasUpdate: hostUpdate || pluginUpdate, known };
    } catch {
      return { hasUpdate: false, known: false };
    }
  }

  // src/client/index.ts
  var ENTRY_REFRESH_MS = 5 * 60 * 1e3;
  function apply(ctx) {
    if (typeof document === "undefined") return;
    const doc = document;
    let disposed = false;
    const teardownEntry = mountFooterEntry(doc, {
      onOpen: () => {
        void openPanel(doc, {
          onState: (state) => {
            if (!disposed) setEntryState(doc, state);
          }
        });
      }
    });
    const view = doc.defaultView;
    let timer = null;
    const refreshEntry = () => {
      void probeEntryState(doc).then((state) => {
        if (!disposed) setEntryState(doc, { ...state, busy: false });
      }).catch(() => {
        if (!disposed) setEntryState(doc, { hasUpdate: false, busy: false, known: false });
      });
    };
    const stop = () => {
      if (disposed) return;
      disposed = true;
      if (timer !== null && view !== null) view.clearInterval(timer);
      timer = null;
      teardownEntry();
    };
    if (ctx !== void 0 && typeof ctx.effect === "function") {
      ctx.effect(() => stop);
    } else if (view !== null) {
      view.addEventListener("pagehide", stop, { once: true });
    }
    refreshEntry();
    if (view !== null) timer = view.setInterval(refreshEntry, ENTRY_REFRESH_MS);
  }
  return __toCommonJS(client_exports);
})();
return __dsh_upgrade_client;
} });
//# sourceMappingURL=client.js.map