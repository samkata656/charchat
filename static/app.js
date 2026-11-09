/* ===========================================================================
   CharChat - front end
   ---------------------------------------------------------------------------
   Plain JavaScript, no build step. The file is split into sections:
     helpers · state · server calls · settings · characters · chats · messages
     · OpenRouter · tabs · stats toggles · watermark · UI wiring

   Note: this page never handles your API key. It asks server.py to talk to
   OpenRouter, and server.py adds the key on its way out.
   =========================================================================== */

/* ======================= helpers ======================= */
const $ = id => document.getElementById(id);

/* Small wrapper around localStorage (this browser's own memory) that never
   throws, so the app still works in private windows. */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  remove(k) { try { localStorage.removeItem(k); } catch {} }
};

const titleCase = s => s.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());

/* Markdown -> safe HTML. marked turns the text into HTML, DOMPurify strips
   anything dangerous (scripts, event handlers) before we show it.
   "breaks" makes a single Enter a real line break, which is what people expect
   when typing in a chat box. */
if (window.marked) marked.setOptions({ breaks: true, gfm: true });

function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  const d = document.createElement("div");
  d.textContent = text;
  return d.innerHTML.replace(/\n/g, "<br>");
}

/* A pasted web address can be hundreds of characters long and would stretch the
   message out of shape. Show a short readable version, keep the real address in
   the link itself, and open it in a new tab. */
function shortenUrl(url) {
  try {
    const parts = new URL(url);
    const host = parts.hostname.replace(/^www\./, "");
    const tail = (parts.pathname + parts.search).replace(/\/$/, "");
    if (!tail || tail === "/") return host;
    const short = tail.length > 28 ? tail.slice(0, 16) + "…" + tail.slice(-8) : tail;
    return host + short;
  } catch {
    return url.length > 44 ? url.slice(0, 40) + "…" : url;
  }
}

function enhanceLinks(root) {
  root.querySelectorAll("a[href]").forEach(link => {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    const href = link.getAttribute("href") || "";
    const shown = link.textContent.trim();
    // Only shorten when the text is the address itself, never a worded link.
    if (shown === href && shown.length > 48) {
      link.title = href;
      link.textContent = shortenUrl(href);
    }
  });
}

/* Put Markdown into an element and tidy up any links it contains. */
function setRichText(el, text) {
  el.innerHTML = md(text);
  enhanceLinks(el);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove("show"), 2200);
}

/* 18240 -> "18.2k", so long numbers stay readable in the stats panel. */
function fmtTokens(n) {
  if (n === null || n === undefined) return "—";
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
}

/* OpenRouter prices are per single token, as text. People think in millions. */
function pricePerMillion(price) {
  const n = Number(price);
  if (!isFinite(n)) return "";
  if (n === 0) return "free";
  return "$" + (n * 1e6).toFixed(2) + "/M";
}

/* ======================= state ======================= */
let settings = { connected: false, key_masked: "", model: "openrouter/auto",
                 ollama_url: "http://localhost:11434", ollama_num_ctx: 8192, ollama_model: "" };
let serverStatus = { lan: false, version: "" };
let models = [];           // the OpenRouter model list, loaded when Settings is opened
let ollamaModels = [];     // the models installed on this computer
let ollamaReachable = null;   // null = not checked yet
/* Which service answers. Kept per browser, not on the server: your PC can reach
   Ollama but your phone usually can't, so each device remembers its own choice. */
let provider = store.get("lc_provider", "openrouter");
let toggles = store.get("lc_toggles", { tokens: true, speed: true, context: true });
let extras = store.get("lc_speed_extras", { promptSpeed: false, ttft: false, orSpeed: false });
let includeOllama = store.get("lc_include_ollama", true);
let chatIndex = [];   // the saved chats of the current character: [{id, title, updated}]
let characterNames = [];
let character = null;   // {id, name, system}
let current = null;   // the chat that is open
let controller = null;   // lets us stop a reply half-way through

/* ======================= talking to server.py ======================= */
/* The X-CharChat header is a simple proof that a request came from this page:
   another website's page cannot add a custom header like it. */
async function api(method, path, body) {
  const headers = { "X-CharChat": "1" };
  if (body) headers["Content-Type"] = "application/json";
  const r = await fetch("/api/" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    let message = "Server error " + r.status;
    try { const j = await r.json(); if (j && j.error) message = j.error; } catch {}
    throw new Error(message);
  }
  return r.json();
}
const chatUrl = (p, id) => "chats/" + encodeURIComponent(p) + "/" + encodeURIComponent(id);

/* ======================= settings (kept by the server) ======================= */
async function loadStatus() {
  try { serverStatus = await api("GET", "status"); } catch {}
  // The --lan warning can be hidden for this browser, but it comes back on a new one.
  if (serverStatus.lan && !store.get("lc_lan_banner_hidden", false)) {
    $("lanBanner").hidden = false;
    document.body.classList.add("has-banner");
  }
}

async function loadSettings() {
  try { settings = await api("GET", "settings"); } catch {}
  renderTop();
  renderSettingsCard();
}

function setHelp(text, kind) {
  const el = $("orHelp");
  el.textContent = text || "";
  el.className = "help" + (kind ? " " + kind : "");
}

/* Show the right buttons for "connected" or "not connected". */
function renderSettingsCard() {
  const on = !!settings.connected;
  $("orDot").classList.toggle("off", !on);
  $("orStatus").textContent = on ? "Connected" : "Not connected";
  $("orMasked").textContent = on ? settings.key_masked : "";
  $("connectBtn").hidden = on;
  $("pasteBtn").hidden = on;
  $("testBtn").hidden = !on;
  $("replaceBtn").hidden = !on;
  $("disconnectBtn").hidden = !on;
  showChosenModel();
  applyToolToggles();
  if (!on) $("pasteRow").hidden = true;
}

/* The things the model is allowed to do on its own, via OpenRouter. */
function applyToolToggles() {
  const on = settings.openrouter_tools || [];
  document.querySelectorAll("[data-tool]").forEach(box => { box.checked = on.includes(box.dataset.tool); });
}
async function saveToolToggles() {
  const chosen = [...document.querySelectorAll("[data-tool]")].filter(b => b.checked).map(b => b.dataset.tool);
  try { settings = await api("PUT", "settings", { openrouter_tools: chosen }); }
  catch (err) { toast(err.message); }
}

/* The model list is big, so it is only fetched when it is first needed.
   The server keeps its own copy for 10 minutes. */
async function loadModels() {
  if (models.length) return;
  try {
    const r = await api("GET", "openrouter/models");
    models = r.models || [];
  } catch (err) {
    $("modelHelp").textContent = "Could not load the model list: " + err.message;
    return;
  }
  $("modelHelp").textContent = `${models.length} models available.`;
  showChosenModel();
  refreshStats();     // the list carries each model's context size, so the bar can fill in
}

/* The one line in Settings describing whichever model is selected. */
function showChosenModel() {
  const id = settings.model || "openrouter/auto";
  const found = models.find(m => m.id === id);
  $("chosenName").textContent = found ? found.name : id;
  const facts = [id];
  if (found?.context_length) facts.push(fmtTokens(found.context_length) + " context");
  const input = pricePerMillion(found?.prompt_price);
  const output = pricePerMillion(found?.completion_price);
  if (input) facts.push(input + " in");
  if (output) facts.push(output + " out");
  $("chosenMeta").textContent = facts.join("  ·  ");
}

/* A proper searchable list, because 468 models in a plain dropdown is unreadable. */
function renderModelRows() {
  const search = $("modelSearch").value.trim().toLowerCase();
  const rows = $("modelRows");
  rows.innerHTML = "";
  const matches = models.filter(m =>
    !search || (m.name || "").toLowerCase().includes(search) || (m.id || "").toLowerCase().includes(search));
  if (!matches.length) {
    rows.innerHTML = '<div class="picker-empty">Nothing matches that.</div>';
    return;
  }
  for (const m of matches.slice(0, 300)) {
    const row = document.createElement("button");
    row.className = "model-row" + (m.id === settings.model ? " active" : "");

    const name = document.createElement("div");
    name.className = "model-row-name";
    name.textContent = m.name;
    if ((m.input_modalities || []).includes("image")) {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = "sees pictures";
      name.appendChild(tag);
    }

    const id = document.createElement("div");
    id.className = "model-row-id"; id.textContent = m.id;

    const facts = document.createElement("div");
    facts.className = "model-row-facts";
    const input = pricePerMillion(m.prompt_price);
    const output = pricePerMillion(m.completion_price);
    const add = (text, cls) => {
      const bit = document.createElement("span");
      if (cls) bit.className = cls;
      bit.textContent = text;
      facts.appendChild(bit);
    };
    if (m.context_length) add(fmtTokens(m.context_length) + " context");
    if (input) add(input + " in", input === "free" ? "free" : "in");
    if (output) add(output + " out");

    row.append(name, id, facts);
    row.onclick = () => chooseModel(m.id);
    rows.appendChild(row);
  }
  if (matches.length > 300) {
    const note = document.createElement("div");
    note.className = "picker-empty";
    note.textContent = `Showing the first 300 of ${matches.length}. Type to narrow it down.`;
    rows.appendChild(note);
  }
}

async function openModelPicker() {
  await loadModels();
  $("modelSearch").value = "";
  renderModelRows();
  openModal("modelModal");
  $("modelSearch").focus();
}

async function chooseModel(id) {
  try {
    settings = await api("PUT", "settings", { model: id });
    showChosenModel();
    renderTop();
    refreshStats();
    closeModals();
    toast("Model set to " + id);
  } catch (err) { toast(err.message); }
}

/* ======================= characters ======================= */
/* Each folder inside /characters that has an identity.md is one character. */
async function listCharacters() {
  try { return await api("GET", "characters"); } catch { return []; }
}
/* The server builds the system prompt out of the .md files. We ask for it fresh
   every time a message is sent, so an edit applies to the very next message. */
async function fetchSystem(id) {
  try { return await api("GET", "characters/" + encodeURIComponent(id) + "/system"); }
  catch { return { prompt: "", user_source: null }; }
}
async function loadCharacter(id) {
  const sys = await fetchSystem(id);
  let info = {};
  try { info = await api("GET", "characters/" + encodeURIComponent(id) + "/info"); } catch {}
  return { id, name: titleCase(id), system: sys.prompt, userSource: sys.user_source,
           avatar: info.avatar || null };
}

/* A character's picture if it has one, otherwise the first letter of its name. */
function paintAvatar(el, who) {
  const subject = who || character;
  if (subject?.avatar) el.innerHTML = `<img src="${subject.avatar}" alt="">`;
  else el.textContent = subject ? subject.name.charAt(0).toUpperCase() : "?";
}
async function initCharacters(keepId) {
  characterNames = await listCharacters();
  const sel = $("characterSelect");
  sel.innerHTML = "";
  if (!characterNames.length) {
    $("topName").textContent = "No characters found";
    showError("Couldn't find any characters. Start the app with start.bat / start.sh (not by opening index.html directly), and make sure there's a folder like characters/nova/identity.md.");
    return;
  }
  for (const n of characterNames) {
    const o = document.createElement("option");
    o.value = n; o.textContent = titleCase(n);
    sel.appendChild(o);
  }
  const wanted = keepId || store.get("lc_character", characterNames[0]);
  await switchCharacter(characterNames.includes(wanted) ? wanted : characterNames[0], !!keepId);
}
async function switchCharacter(id, keepChat) {
  try { character = await loadCharacter(id); }
  catch (e) { showError(e.message); return; }
  store.set("lc_character", id);
  $("characterSelect").value = id;
  paintAvatar($("topAvatar"));
  $("topName").textContent = character.name;
  await refreshIndex();
  if (!keepChat || !current || current.character !== id) {
    current = null;
    if (chatIndex.length) await openChat(chatIndex[0].id);   // reopen the most recent chat
    if (!current) current = newChat();
  }
  renderAll();
}

/* ======================= chats (kept in data/app.db) ======================= */
function newChat() {
  const d = new Date(), pad = n => String(n).padStart(2, "0");
  // id like 2026-10-25_213412_k3f9 - sorts by date and is easy to read
  const id = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
             `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_` +
             `${Math.random().toString(36).slice(2, 6)}`;
  return { id, character: character.id, title: "New chat", messages: [], created: Date.now(), updated: Date.now() };
}
async function refreshIndex() {
  try { chatIndex = await api("GET", "chats/" + encodeURIComponent(character.id)); }
  catch { chatIndex = []; toast("Couldn't load saved chats"); }
}
async function openChat(id) {
  try { current = await api("GET", chatUrl(character.id, id)); }
  catch { toast("Couldn't open that chat"); }
  pending = [];            // an attached picture belongs to the chat you were in
  renderAttachments();
}
async function persist(chat) {
  chat.updated = Date.now();
  if (chat.character === character?.id) {   // keep the sidebar list in sync without asking the server
    const entry = chatIndex.find(c => c.id === chat.id);
    if (entry) { entry.title = chat.title; entry.updated = chat.updated; }
    else chatIndex.unshift({ id: chat.id, title: chat.title, updated: chat.updated });
    chatIndex.sort((a, b) => b.updated - a.updated);
  }
  try { await api("PUT", chatUrl(chat.character, chat.id), chat); }
  catch { toast("Couldn't save - is the CharChat window still open?"); }
}
/* Drop a chat that ended up with no messages in it (a failed first send). */
async function forgetChat(chat) {
  chatIndex = chatIndex.filter(c => c.id !== chat.id);
  try { await api("DELETE", chatUrl(chat.character, chat.id)); } catch {}
}

/* One-time move of chats saved by the oldest version (browser storage). */
async function migrateOldChats() {
  const old = store.get("lc_chats", null);
  if (!Array.isArray(old) || !old.length) return;
  let moved = 0;
  for (const c of old) {
    if (!c?.messages?.length || !c.character || !c.id) continue;
    try { await api("PUT", chatUrl(c.character, c.id), c); moved++; }
    catch { return; }   // server down: leave the old data alone and try again next time
  }
  store.remove("lc_chats");
  if (moved) toast(`Moved ${moved} old chat${moved > 1 ? "s" : ""} into the database`);
}
function renderChatList() {
  const list = $("chatList");
  list.innerHTML = "";
  if (!chatIndex.length) { list.innerHTML = '<div class="empty-list">No saved chats yet.</div>'; return; }
  for (const c of chatIndex) {
    const row = document.createElement("div");
    row.className = "chat-item" + (current && c.id === current.id ? " active" : "");
    row.title = new Date(c.updated).toLocaleString();

    const t = document.createElement("span");
    t.className = "t"; t.textContent = c.title;

    const del = document.createElement("button");
    del.className = "del"; del.title = "Delete chat"; del.innerHTML = iconSvg("close", 16);
    del.onclick = async e => {
      e.stopPropagation();
      if (controller || !confirm('Delete "' + c.title + '"?')) return;
      try { await api("DELETE", chatUrl(character.id, c.id)); }
      catch { toast("Couldn't delete"); return; }
      chatIndex = chatIndex.filter(x => x.id !== c.id);
      if (current?.id === c.id) current = newChat();
      renderAll();
    };

    row.onclick = async () => {
      if (controller || current?.id === c.id) { closeSidebar(); return; }
      await openChat(c.id); renderAll(); closeSidebar();
    };
    row.append(t, del);
    list.appendChild(row);
  }
}

/* ======================= messages ======================= */
function renderMessages() {
  const inner = $("inner");
  inner.innerHTML = "";
  if (!current.messages.length) {
    inner.innerHTML = `<div class="welcome"><div class="avatar" id="welcomeAvatar"></div>
      <h2>Chat with ${character.name}</h2>
      <p>Open <strong>Characters</strong> in the sidebar to change how ${character.name} behaves, or to
      tell every character a bit about you. Edits apply to your next message.</p></div>`;
    paintAvatar($("welcomeAvatar"));
    refreshStats();
    return;
  }
  current.messages.forEach((m, i) => addMessageEl(m, i));
  scrollDown(true);
  refreshStats();
}

/* Everything in the side panel and the context bar, redrawn from the open chat. */
function refreshStats() {
  updateContextBar();
  renderSpeed();
  renderTokens();
}
function addMessageEl(m, index) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + m.role;

  if (m.role === "user") {
    const b = document.createElement("div");
    b.className = "bubble content";     // your own messages are Markdown too
    if (m.images?.length) b.appendChild(imagesRow(m.images));
    if (m.content) {
      const text = document.createElement("div");
      setRichText(text, m.content);
      b.appendChild(text);
    }
    wrap.appendChild(b);
  } else {
    const av = document.createElement("div");
    av.className = "avatar sm"; paintAvatar(av);

    const body = document.createElement("div");
    body.className = "body";

    // Models that reason first write that out before the answer. It's folded
    // away, but it's there - and it explains the output token count.
    if (m.thinking) {
      const reasoned = Math.round(m.usage?.completion_tokens_details?.reasoning_tokens || 0);
      const box = document.createElement("details");
      box.className = "thinking-box";
      const head = document.createElement("summary");
      head.textContent = reasoned
        ? `Thought first — about ${reasoned} of the output tokens`
        : "Thought first";
      const text = document.createElement("div");
      text.className = "thinking-text";
      text.textContent = m.thinking;
      box.append(head, text);
      body.appendChild(box);
    }

    const content = document.createElement("div");
    content.className = "content";
    if (m.content) setRichText(content, m.content);
    else content.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';

    const meta = document.createElement("div");
    meta.className = "meta";
    if (m.content) {
      const copy = document.createElement("button");
      copy.innerHTML = iconSvg("copy", 14) + " Copy";
      copy.onclick = () => { navigator.clipboard?.writeText(m.content); toast("Copied"); };
      meta.appendChild(copy);

      if (index === current.messages.length - 1) {
        const regen = document.createElement("button");
        regen.innerHTML = iconSvg("rotate", 14) + " Regenerate";
        regen.onclick = () => { if (controller) return; current.messages.pop(); renderMessages(); ask(); };
        meta.appendChild(regen);
      }
      if (m.model) {
        const s = document.createElement("span");
        s.className = "model-name"; s.textContent = m.model;
        meta.appendChild(s);
      }
    }
    body.append(content, meta);
    wrap.append(av, body);
  }
  $("inner").appendChild(wrap);
  return wrap;
}
/* The pictures that were sent with a message. Clicking one opens it full size. */
function imagesRow(images) {
  const row = document.createElement("div");
  row.className = "msg-images";
  for (const image of images) {
    const img = document.createElement("img");
    img.src = image.url;
    img.alt = "attached picture";
    img.loading = "lazy";
    img.onclick = () => window.open(image.url, "_blank", "noopener");
    row.appendChild(img);
  }
  return row;
}

function showError(text) {
  const e = document.createElement("div");
  e.className = "error-box"; e.textContent = text;
  $("inner").appendChild(e);
  scrollDown(true);
}
function scrollDown(force) {
  const box = $("messages");
  if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 120) box.scrollTop = box.scrollHeight;
}

/* ======================= pictures you attach to a message ======================= */
let pending = [];          // uploaded and waiting to be sent with the next message

function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  box.hidden = !pending.length;
  pending.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "attachment" + (item.url ? "" : " busy");
    const img = document.createElement("img");
    img.src = item.preview || item.url;
    card.appendChild(img);
    const drop = document.createElement("button");
    drop.className = "drop"; drop.title = "Remove";
    drop.innerHTML = iconSvg("close", 12);
    drop.onclick = () => { pending.splice(index, 1); renderAttachments(); };
    card.appendChild(drop);
    box.appendChild(card);
  });
}

/* Upload straight away, so sending is instant and the file lives on disk
   rather than inside the chat database. */
async function attachImage(file) {
  if (!file || !file.type.startsWith("image/")) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const item = { preview: reader.result, url: null };
    pending.push(item);
    renderAttachments();
    try {
      const saved = await api("POST", "uploads", { image: reader.result });
      Object.assign(item, saved);
    } catch (err) {
      pending = pending.filter(p => p !== item);
      toast(err.message);
    }
    renderAttachments();
  };
  reader.readAsDataURL(file);
}

/* Turn a stored picture back into a data URL, which is what both providers want. */
async function imageAsDataUrl(image) {
  if (image.dataUrl) return image.dataUrl;
  const res = await fetch(image.url);
  const blob = await res.blob();
  return await new Promise(done => {
    const reader = new FileReader();
    reader.onload = () => done(reader.result);
    reader.readAsDataURL(blob);
  });
}

/* Build the messages list for the provider, with any pictures included. */
async function buildMessages(systemPrompt, history, viaOllama) {
  const out = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
  for (const m of history) {
    const images = m.images || [];
    if (!images.length) { out.push({ role: m.role, content: m.content }); continue; }
    const urls = await Promise.all(images.map(imageAsDataUrl));
    if (viaOllama) {
      // Ollama wants the raw base64, without the "data:image/png;base64," part
      out.push({ role: m.role, content: m.content,
                 images: urls.map(u => u.slice(u.indexOf(",") + 1)) });
    } else {
      out.push({ role: m.role, content: [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...urls.map(u => ({ type: "image_url", image_url: { url: u } }))
      ] });
    }
  }
  return out;
}

/* Does the chosen model accept pictures at all? */
function modelTakesImages() {
  if (provider === "ollama") {
    const found = ollamaModels.find(m => m.name === settings.ollama_model);
    return !found || (found.capabilities || []).includes("vision");
  }
  const found = models.find(m => m.id === (settings.model || ""));
  return !found || (found.input_modalities || []).includes("image");
}

/* ======================= asking for a reply ======================= */
/* Read a streaming response one line at a time. Both providers send their
   answer as a stream of lines, so both use this. */
async function* readLines(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) yield line;
  }
  if (buffer.trim()) yield buffer;
}

/* OpenRouter: goes through our own server, which adds the API key.
   The lines are SSE (Server-Sent Events): "data: {...}". */
async function streamOpenRouter(model, messages, signal, onPiece) {
  const res = await fetch("/api/openrouter/chat", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-CharChat": "1" },
    body: JSON.stringify({ model, messages })
  });
  if (!res.ok) {
    let message = "Request failed (" + res.status + ")";
    try { const j = await res.json(); if (j && j.error) message = j.error; } catch {}
    throw new Error(message);
  }
  let usage = null, firstAt = null, lastAt = null;
  const started = performance.now();
  for await (const line of readLines(res)) {
    if (!line.startsWith("data: ")) continue;      // ": comment" lines are keep-alives
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    // Once the reply has started, OpenRouter can't change the status code any
    // more, so a failure partway through arrives as a normal line with "error"
    // in it. Stop there and say so, instead of quietly ending the reply.
    if (chunk.error) {
      throw new Error("OpenRouter: " + (chunk.error.message || "the reply was cut off"));
    }
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) {
      if (firstAt === null) firstAt = performance.now();
      lastAt = performance.now();
      onPiece(piece);
    }
    if (chunk.usage) usage = chunk.usage;          // the last chunk carries tokens and cost
  }
  // OpenRouter doesn't report its own speed, so this is measured here and
  // labelled an estimate: output tokens over the time text was arriving.
  const stats = { provider: "openrouter" };
  if (firstAt !== null) stats.ttft_ms = Math.round(firstAt - started);
  const span = lastAt && firstAt ? (lastAt - firstAt) / 1000 : 0;
  if (span > 0 && usage?.completion_tokens) {
    stats.tps_estimate = usage.completion_tokens / span;
    stats.out_tokens = usage.completion_tokens;
    stats.gen_ms = Math.round(span * 1000);
  }
  return { usage, stats };
}

/* Ollama: the browser talks to it directly, because it runs on your own
   computer. Its replies are NDJSON - one complete JSON object per line. */
async function streamOllama(model, messages, signal, onPiece, onThinking) {
  const res = await fetch(ollamaBase() + "/api/chat", {
    method: "POST", signal,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model, messages, stream: true,
      options: { num_ctx: Number(settings.ollama_num_ctx) || 8192 }
    })
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(ollamaErrorText(res.status, text));
  }
  let final = null, firstAt = null, thinking = "", answered = 0;
  const started = performance.now();
  for await (const line of readLines(res)) {
    const text = line.trim();
    if (!text) continue;
    let chunk;
    try { chunk = JSON.parse(text); } catch { continue; }
    if (chunk.error) throw new Error("Ollama: " + chunk.error);
    // Some models "think" before answering. That arrives as message.thinking,
    // separate from the answer - and it counts towards the output tokens, which
    // is why a short reply can report a surprisingly big number.
    const thought = chunk.message?.thinking;
    if (thought) { thinking += thought; onThinking(thought); }
    const piece = chunk.message?.content;
    if (piece) {
      if (firstAt === null) firstAt = performance.now();
      answered += piece.length;
      onPiece(piece);
    }
    if (chunk.done) final = chunk;
  }

  // Ollama reports its own timings, in nanoseconds.
  const stats = { provider: "ollama" };
  let usage = null;
  if (final) {
    if (final.eval_count && final.eval_duration) {
      stats.tps = final.eval_count / (final.eval_duration / 1e9);
      stats.out_tokens = final.eval_count;
      stats.gen_ms = Math.round(final.eval_duration / 1e6);
    }
    if (final.prompt_eval_count && final.prompt_eval_duration) {
      stats.prompt_tps = final.prompt_eval_count / (final.prompt_eval_duration / 1e9);
    }
    if (final.load_duration) stats.load_ms = Math.round(final.load_duration / 1e6);
    usage = {
      prompt_tokens: final.prompt_eval_count || 0,
      completion_tokens: final.eval_count || 0,
      prompt_tokens_details: { cached_tokens: final.prompt_eval_cached_count || 0 }
    };
    // Ollama reports one output total covering thinking AND the answer. Split it
    // by how much text each produced, so the numbers make sense. It's a share of
    // a real total, not a guess at the total itself, but still an estimate.
    if (thinking && final.eval_count) {
      const share = thinking.length / (thinking.length + answered || 1);
      usage.completion_tokens_details = {
        reasoning_tokens: Math.round(final.eval_count * share),
        estimated: true
      };
    }
  }
  if (firstAt !== null) stats.ttft_ms = Math.round(firstAt - started);
  return { usage, stats, thinking };
}

/* Nothing can be sent yet (no key, or no model chosen). Give the typed message
   back to the input box instead of leaving it stranded in the chat. */
async function cancelSend(chat, why) {
  if (chat.messages.at(-1)?.role === "user") {
    $("input").value = chat.messages.pop().content;
    autoGrow();
  }
  if (chat.messages.length) await persist(chat);
  else await forgetChat(chat);
  if (chat === current) { renderMessages(); renderChatList(); }
  openSettings();
  toast(why);
}

async function ask() {
  const viaOllama = provider === "ollama";
  const chat = current;                            // remember which chat this reply belongs to
  if (!viaOllama && !settings.connected) return cancelSend(chat, "Connect OpenRouter first");
  if (viaOllama && !settings.ollama_model) return cancelSend(chat, "Choose an Ollama model first");

  const model = viaOllama ? settings.ollama_model : (settings.model || "openrouter/auto");

  // Rebuilt from the .md files right now, so edits need no reload.
  const sys = await fetchSystem(character.id);
  character.system = sys.prompt;
  character.userSource = sys.user_source;
  const messages = await buildMessages(sys.prompt, chat.messages, viaOllama);

  if ($("inner").querySelector(".welcome")) $("inner").innerHTML = "";
  const el = addMessageEl({ role: "assistant", content: "" });
  const contentEl = el.querySelector(".content");
  scrollDown(true);
  controller = new AbortController();
  setBusy(true);

  let answer = "", usage = null, stats = null, failure = null, thinking = false, reasoning = "";
  // Words can arrive hundreds of times a second. Turning the whole answer into
  // HTML after every one gets slower as the answer grows, so redraw at most
  // once per screen refresh instead.
  let drawQueued = false;
  const draw = () => {
    drawQueued = false;
    contentEl.innerHTML = md(answer);
    scrollDown();
  };
  const onPiece = piece => {
    answer += piece;
    if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); }
  };
  const onThinking = () => {
    if (answer || thinking) return;
    thinking = true;
    contentEl.innerHTML = '<div class="thinking-note">Thinking…</div>';
  };

  try {
    const result = viaOllama
      ? await streamOllama(model, messages, controller.signal, onPiece, onThinking)
      : await streamOpenRouter(model, messages, controller.signal, onPiece);
    usage = result.usage;
    stats = result.stats;
    reasoning = result.thinking || "";
  } catch (err) {
    if (err.name !== "AbortError") {
      failure = err.message;     // shown after the redraw below, or it would be wiped
      el.remove();
      if (!answer && chat.messages.at(-1)?.role === "user") {
        // nothing came back: put the question back in the input box
        $("input").value = chat.messages.pop().content;
        autoGrow();
      }
    }
  } finally {
    controller = null;
    setBusy(false);
    if (answer) {
      const message = { role: "assistant", content: answer, provider: viaOllama ? "ollama" : "openrouter", model };
      if (usage) message.usage = usage;
      if (stats) message.stats = stats;
      if (reasoning) message.thinking = reasoning;
      chat.messages.push(message);
    }
    if (chat.messages.length) {
      await persist(chat);
    } else {
      // The very first message failed and went back into the input box, so this
      // chat is empty - don't leave a blank entry sitting in the history.
      await forgetChat(chat);
    }
    if (chat === current) {
      renderMessages();      // redraw from the real list, so nothing stale is left on screen
      renderChatList();
      if (failure) showError(failure);
      $("input").focus();
    }
  }
}
function setBusy(b) {
  const s = $("sendBtn");
  s.classList.toggle("stop", b);
  s.title = b ? "Stop" : "Send";
  s.innerHTML = iconSvg(b ? "stop" : "send", b ? 16 : 18);
}

/* ======================= tabs (Chat / Image / Video) ======================= */
/* The sidebar stays in place on every tab and swaps its contents, so the layout
   never jumps: the image gallery and the video job list are each tab's version
   of the chat history. */
let currentTab = "chat";

function switchTab(name) {
  currentTab = name;
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  for (const v of ["chat", "image", "video"]) {
    const Big = v.charAt(0).toUpperCase() + v.slice(1);
    $("view" + Big).hidden = v !== name;
    $("side" + Big).hidden = v !== name;
  }
  closeSidebar();
  if (name === "image") { loadImageModels(); loadGallery(); }
  if (name === "video") { loadVideoModels(); loadVideoGallery(); } else { stopVideoPolling(); }
}

/* ======================= Ollama (models on your own computer) ======================= */
function ollamaBase() {
  return (settings.ollama_url || "http://localhost:11434").replace(/\/+$/, "");
}
function onLocalhost() {
  return ["localhost", "127.0.0.1", "[::1]", ""].includes(location.hostname);
}

/* Ollama only answers pages it has been told to trust. If this page is served
   from anything other than localhost, it refuses - and the fix is an
   environment variable, so explain it rather than just saying "failed". */
function ollamaOriginHelp() {
  return "Ollama only answers pages it trusts, and it doesn't know <code>" + location.origin +
    "</code> yet.<br>On Windows, open Command Prompt and run:<br>" +
    "<code>setx OLLAMA_ORIGINS \"" + location.origin + "\"</code><br>" +
    "Then quit Ollama from the system tray (near the clock) and start it again.";
}
function ollamaErrorText(status, body) {
  if (status === 403) return "Ollama refused this page. " + ollamaOriginHelp().replace(/<[^>]+>/g, " ");
  if (status === 404) return "Ollama doesn't have that model. Pull it first, for example: ollama pull " +
                             (settings.ollama_model || "llama3.2");
  return "Ollama returned " + status + (body ? ": " + body.slice(0, 200) : "");
}

/* Ask Ollama which models are installed. Doubles as the reachability check.
   The first attempt sometimes fails right after a failed one (the browser backs
   off briefly), so a single retry saves a misleading "not reachable". */
async function fetchTags() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(ollamaBase() + "/api/tags", { signal: AbortSignal.timeout(4000) });
      if (!res.ok) throw new Error(ollamaErrorText(res.status, ""));
      return res;
    } catch (err) {
      if (attempt) throw err;
      await new Promise(done => setTimeout(done, 400));
    }
  }
}

async function checkOllama() {
  try {
    const res = await fetchTags();
    const data = await res.json();
    ollamaModels = (data.models || []).map(m => ({
      name: m.name || m.model,
      context: m.details?.context_length || null,
      capabilities: m.capabilities || []      // tells us if it can look at pictures
    }));
    ollamaReachable = true;
    if (!settings.ollama_model && ollamaModels.length) {
      // Nothing chosen yet: take the first one, so the dropdown and the app agree.
      await saveOllamaModel(ollamaModels[0].name);
    } else {
      fillOllamaModels();
    }
    renderProvider();
    return { ok: true };
  } catch (err) {
    ollamaReachable = false;
    ollamaModels = [];
    fillOllamaModels();
    renderProvider();
    if (provider === "ollama") setProvider("openrouter");
    return {
      ok: false,
      html: onLocalhost()
        ? "Couldn't reach Ollama at <code>" + ollamaBase() + "</code>. Is it running?"
        : ollamaOriginHelp()
    };
  }
}

/* Some models have their own maximum context, which Ollama reports per model. */
async function ollamaModelContext(name) {
  const known = ollamaModels.find(m => m.name === name);
  if (known?.context) return known.context;
  try {
    const res = await fetch(ollamaBase() + "/api/show", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(4000)
    });
    if (!res.ok) return null;
    const data = await res.json();
    const info = data.model_info || {};
    const key = Object.keys(info).find(k => k.endsWith(".context_length"));
    return key ? info[key] : (data.details?.context_length || null);
  } catch { return null; }
}

function fillOllamaModels() {
  for (const sel of [$("ollamaModelSelect"), $("ollamaModelSetting")]) {
    sel.innerHTML = "";
    if (!ollamaModels.length) {
      const o = document.createElement("option");
      o.value = ""; o.textContent = ollamaReachable === false ? "Not reachable" : "No models installed";
      sel.appendChild(o);
      continue;
    }
    for (const m of ollamaModels) {
      const o = document.createElement("option");
      o.value = m.name; o.textContent = m.name;
      sel.appendChild(o);
    }
    sel.value = settings.ollama_model || ollamaModels[0].name;
  }
}

async function saveOllamaModel(name) {
  try {
    settings = await api("PUT", "settings", { ollama_model: name });
    fillOllamaModels();
    renderTop();
    refreshStats();
  } catch (err) { toast(err.message); }
}

/* ---- which service answers ---- */
function setProvider(name) {
  if (name === "ollama" && ollamaReachable === false) return;
  provider = name;
  store.set("lc_provider", name);
  renderProvider();
  refreshStats();        // the context limit belongs to the provider, so it changes too
}
function renderProvider() {
  document.querySelectorAll(".prov").forEach(b => {
    const isOllama = b.dataset.provider === "ollama";
    b.classList.toggle("active", b.dataset.provider === provider);
    b.disabled = isOllama && ollamaReachable === false;
    if (isOllama) {
      b.title = ollamaReachable === false
        ? "Ollama not reachable from this device"
        : "Models running on your own computer";
    }
  });
  $("modelChip").hidden = provider !== "openrouter";
  $("ollamaModelWrap").hidden = provider !== "ollama";
  renderTop();
}

/* ======================= the Image tab ======================= */
let imageModels = [];
let imageDetail = null;      // the chosen model's prices and options
let imageRef = null;         // a reference picture, as a data URL
let galleryItems = [];
let viewing = null;          // {item, index} while the full-size viewer is open

/* Every image model accepts a different set of options, so the controls are
   built from what the model itself says it supports. */
const OPTION_LABELS = {
  resolution: "Resolution", aspect_ratio: "Aspect ratio", size: "Size",
  quality: "Quality", output_format: "File format", background: "Background"
};

async function loadImageModels() {
  if (imageModels.length) return;
  $("imgModelHelp").textContent = "Loading models…";
  try {
    const r = await api("GET", "openrouter/image-models");
    imageModels = r.models || [];
  } catch (err) {
    $("imgModelHelp").textContent = "Couldn't load the image models: " + err.message;
    return;
  }
  const select = $("imgModel");
  select.innerHTML = "";
  for (const m of imageModels) {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.name;
    select.appendChild(o);
  }
  const remembered = store.get("lc_image_model", "");
  select.value = imageModels.some(m => m.id === remembered) ? remembered : imageModels[0].id;
  await chooseImageModel(select.value);
}

async function chooseImageModel(id) {
  store.set("lc_image_model", id);
  const model = imageModels.find(m => m.id === id);
  $("imgModelHelp").textContent = "Loading this model's options…";
  imageDetail = null;
  try {
    imageDetail = await api("GET", "openrouter/image-model?id=" + encodeURIComponent(id));
  } catch {
    imageDetail = null;      // fall back to the options from the list
  }
  const supported = imageDetail?.supported_parameters || model?.supported_parameters || {};
  buildImageOptions(supported);
  // image-to-image is only offered when the model takes reference pictures
  const refs = supported.input_references;
  $("imgRefBlock").hidden = !(refs && (refs.max || 0) > 0);
  if ($("imgRefBlock").hidden) clearReference();
  $("imgModelHelp").textContent = imageDetail?.provider ? "Runs on " + imageDetail.provider + "." : "";
  updateImageCost();
}

function buildImageOptions(supported) {
  const box = $("imgOptions");
  box.innerHTML = "";
  for (const [name, label] of Object.entries(OPTION_LABELS)) {
    const spec = supported[name];
    if (!spec || spec.type !== "enum" || !Array.isArray(spec.values)) continue;
    const block = document.createElement("div");
    block.innerHTML = `<div class="label">${label}</div>
      <div class="select-wrap"><select class="select" data-option="${name}"></select>
      <span class="select-arrow" data-icon="chevron-down"></span></div>`;
    const select = block.querySelector("select");
    for (const value of spec.values) {
      const o = document.createElement("option");
      o.value = value; o.textContent = value;
      select.appendChild(o);
    }
    const remembered = store.get("lc_image_opt_" + name, "");
    if (spec.values.includes(remembered)) select.value = remembered;
    select.onchange = () => { store.set("lc_image_opt_" + name, select.value); updateImageCost(); };
    box.appendChild(block);
  }
  // how many pictures at once
  const n = supported.n;
  if (n && n.type === "range" && (n.max || 1) > 1) {
    const block = document.createElement("div");
    block.innerHTML = `<div class="label">How many</div>
      <input type="number" id="imgCount" min="${n.min || 1}" max="${n.max}" value="1">`;
    box.appendChild(block);
    block.querySelector("input").oninput = updateImageCost;
  }
  drawIcons(box);
}

function imageOptions() {
  const chosen = {};
  document.querySelectorAll("#imgOptions [data-option]").forEach(s => { chosen[s.dataset.option] = s.value; });
  const count = $("imgCount");
  if (count) chosen.n = Math.max(1, Number(count.value) || 1);
  return chosen;
}

/* Work out roughly what a generation will cost from the model's price list. */
function updateImageCost() {
  const prices = imageDetail?.pricing || [];
  const chosen = imageOptions();
  const count = chosen.n || 1;
  const outputs = prices.filter(p => p.billable === "output_image");
  if (!outputs.length) {
    $("imgCost").textContent = prices.length ? "" : "Price unknown for this model";
    return;
  }
  const wanted = (chosen.resolution || chosen.size || "").toLowerCase();
  const match = outputs.find(p => (p.variant || "").toLowerCase() === wanted) || outputs[0];
  const each = Number(match.cost_usd) || 0;
  if (!each) { $("imgCost").textContent = "Free with this model"; return; }
  const total = each * count;
  $("imgCost").textContent = `About $${total.toFixed(3)} for ${count} image${count === 1 ? "" : "s"}`;
}

function setImageHelp(text, kind) {
  const el = $("imgHelp");
  el.textContent = text || "";
  el.className = "help" + (kind ? " " + kind : "");
}

function clearReference() {
  imageRef = null;
  $("imgRefPreview").hidden = true;
  $("imgRefPreview").removeAttribute("src");
  $("imgRefClear").hidden = true;
}

function useReference(dataUrl) {
  imageRef = dataUrl;
  $("imgRefPreview").src = dataUrl;
  $("imgRefPreview").hidden = false;
  $("imgRefClear").hidden = false;
  $("imgRefBlock").hidden = false;
}

async function generateImage() {
  const prompt = $("imgPrompt").value.trim();
  if (!prompt) { setImageHelp("Write a prompt first.", "bad"); return; }
  if (!settings.connected) { openSettings(); toast("Connect OpenRouter first"); return; }

  const button = $("imgGenerate");
  button.disabled = true;
  setImageHelp("Generating… this can take up to a minute.");
  const body = Object.assign({ model: $("imgModel").value, prompt }, imageOptions());
  if (imageRef) body.input_references = [{ type: "image_url", image_url: { url: imageRef } }];

  try {
    const made = await api("POST", "openrouter/image", body);
    setImageHelp(made.cost ? `Done — this one cost $${Number(made.cost).toFixed(3)}.` : "Done.", "good");
    await loadGallery();
  } catch (err) {
    setImageHelp(err.message, "bad");
  } finally {
    button.disabled = false;
  }
}

async function loadGallery() {
  try { galleryItems = await api("GET", "media?kind=image"); }
  catch { galleryItems = []; }
  const grid = $("imgGallery");
  grid.innerHTML = "";
  if (!galleryItems.length) {
    grid.innerHTML = '<div class="gallery-empty">Nothing generated yet. Your images will appear here.</div>';
    return;
  }
  for (const item of galleryItems) {
    item.files.forEach((file, index) => {
      const card = document.createElement("div");
      card.className = "shot";
      card.title = item.prompt || "";
      const img = document.createElement("img");
      img.src = `/api/media/${encodeURIComponent(item.id)}/${index}`;
      img.alt = item.prompt || "generated image";
      img.loading = "lazy";
      card.appendChild(img);
      if (item.cost) {
        const tag = document.createElement("span");
        tag.className = "shot-cost";
        tag.textContent = "$" + Number(item.cost).toFixed(3);
        card.appendChild(tag);
      }
      card.onclick = () => openViewer(item, index);
      grid.appendChild(card);
    });
  }
}

function openViewer(item, index) {
  viewing = { item, index };
  $("viewerImg").src = `/api/media/${encodeURIComponent(item.id)}/${index}`;
  $("viewerPrompt").textContent = item.prompt || "";
  const bits = [item.model];
  if (item.cost) bits.push("$" + Number(item.cost).toFixed(3));
  for (const [k, v] of Object.entries(item.params || {})) {
    if (k !== "n") bits.push(k.replace(/_/g, " ") + " " + v);
  }
  bits.push(new Date(item.created).toLocaleString());
  $("viewerMeta").textContent = bits.filter(Boolean).join("  ·  ");
  openModal("imageModal");
}

/* ======================= the Video tab ======================= */
/* Videos are slow, so OpenRouter hands back a job and the server watches it.
   This page just shows what the server knows, refreshing while anything runs. */
let videoModels = [];
let videoItems = [];
let videoEstimate = null;
let videoTimer = null;

async function loadVideoModels() {
  if (videoModels.length) return;
  $("vidModelHelp").textContent = "Loading models…";
  try {
    const r = await api("GET", "openrouter/video-models");
    videoModels = r.models || [];
  } catch (err) {
    $("vidModelHelp").textContent = "Couldn't load the video models: " + err.message;
    return;
  }
  const select = $("vidModel");
  select.innerHTML = "";
  for (const m of videoModels) {
    const o = document.createElement("option");
    o.value = m.id; o.textContent = m.name;
    select.appendChild(o);
  }
  const remembered = store.get("lc_video_model", "");
  select.value = videoModels.some(m => m.id === remembered) ? remembered : videoModels[0].id;
  chooseVideoModel(select.value);
}

function chooseVideoModel(id) {
  store.set("lc_video_model", id);
  const model = videoModels.find(m => m.id === id);
  const box = $("vidOptions");
  box.innerHTML = "";
  if (!model) return;

  const addSelect = (name, label, values, suffix) => {
    if (!values || !values.length) return;
    const block = document.createElement("div");
    block.innerHTML = `<div class="label">${label}</div>
      <div class="select-wrap"><select class="select" data-voption="${name}"></select>
      <span class="select-arrow" data-icon="chevron-down"></span></div>`;
    const select = block.querySelector("select");
    for (const value of values) {
      const o = document.createElement("option");
      o.value = value; o.textContent = value + (suffix || "");
      select.appendChild(o);
    }
    const remembered = store.get("lc_video_opt_" + name, "");
    if (values.map(String).includes(String(remembered))) select.value = remembered;
    select.onchange = () => { store.set("lc_video_opt_" + name, select.value); updateVideoCost(); };
    box.appendChild(block);
  };

  addSelect("duration", "Duration", model.durations, "s");
  addSelect("resolution", "Resolution", model.resolutions);
  addSelect("aspect_ratio", "Aspect ratio", model.aspect_ratios);
  drawIcons(box);
  $("vidModelHelp").textContent = model.durations.length
    ? ""
    : "This model decides the length itself.";
  updateVideoCost();
}

function videoOptions() {
  const chosen = {};
  document.querySelectorAll("#vidOptions [data-voption]").forEach(s => { chosen[s.dataset.voption] = s.value; });
  return chosen;
}

/* The price list uses many different key names across models, and two units:
   keys beginning "cents_per_" are in cents, the rest are already in dollars.
   This picks the entry that best matches the chosen resolution. */
function videoRate(skus, resolution) {
  const wanted = (resolution || "").toLowerCase();
  const ignore = ["image", "reference", "continuation", "token", "megapixel", "minimum"];
  const candidates = Object.entries(skus || {})
    .filter(([key]) => {
      const k = key.toLowerCase();
      return k.includes("second") && !ignore.some(bad => k.includes(bad));
    })
    .map(([key, value]) => {
      const k = key.toLowerCase();
      const dollars = k.startsWith("cents_per") ? Number(value) / 100 : Number(value);
      let score = 0;
      if (wanted && k.endsWith(wanted)) score += 10;          // exactly this resolution
      else if (wanted && k.includes(wanted)) score += 8;
      else if (!/\d{3,4}p$|\dk$/.test(k)) score += 4;          // a rate that covers everything
      if (k.includes("audio")) score -= 1;
      return { key, dollars, score };
    })
    .filter(c => isFinite(c.dollars) && c.dollars > 0)
    // Best match first; on a tie take the dearer one, so an estimate is never
    // lower than what you actually get charged (audio on vs off, say).
    .sort((a, b) => b.score - a.score || b.dollars - a.dollars);
  return candidates[0] || null;
}

function updateVideoCost() {
  const model = videoModels.find(m => m.id === $("vidModel").value);
  const chosen = videoOptions();
  const duration = Number(chosen.duration) || 0;
  const skus = model?.pricing_skus || {};
  const rate = videoRate(skus, chosen.resolution);

  if (!rate || !duration) {
    // Can't work out a total (some models are priced per token or per
    // megapixel), so show the rates themselves rather than invent a number.
    const shown = Object.entries(skus).slice(0, 2)
      .map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join("  ·  ");
    $("vidCost").textContent = shown ? "Rate — " + shown : "Price unknown for this model";
    videoEstimate = null;
    return;
  }
  const minimum = Number(skus.minimum_cents_per_generation || 0) / 100;
  videoEstimate = Math.max(rate.dollars * duration, minimum);
  $("vidCost").textContent = `About $${videoEstimate.toFixed(2)} for ${duration}s` +
    (chosen.resolution ? ` at ${chosen.resolution}` : "");
}

function setVideoHelp(text, kind) {
  const el = $("vidHelp");
  el.textContent = text || "";
  el.className = "help" + (kind ? " " + kind : "");
}

async function generateVideo() {
  if (!settings.connected) { openSettings(); toast("Connect OpenRouter first"); return; }
  const prompt = $("vidPrompt").value.trim();
  if (!prompt) { setVideoHelp("Write a prompt first.", "bad"); return; }

  // Videos get expensive. Anything over a dollar is confirmed first - and so is
  // anything whose price can't be worked out in advance.
  if (videoEstimate === null) {
    const ok = confirm("This model's price can't be worked out in advance, so this video could " +
                       "cost more than you expect.\n\nGenerate it anyway?");
    if (!ok) return;
  } else if (videoEstimate > 1) {
    const ok = confirm(`This video should cost about $${videoEstimate.toFixed(2)}.\n\nGenerate it?`);
    if (!ok) return;
  }

  const button = $("vidGenerate");
  button.disabled = true;
  setVideoHelp("Starting the job…");
  try {
    await api("POST", "openrouter/video", Object.assign(
      { model: $("vidModel").value, prompt }, videoOptions()));
    setVideoHelp("Started. It keeps going even if you close this tab.", "good");
    $("vidPrompt").value = "";
    await loadVideoGallery();
  } catch (err) {
    setVideoHelp(err.message, "bad");
  } finally {
    button.disabled = false;
  }
}

function stopVideoPolling() {
  if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
}

async function loadVideoGallery() {
  try { videoItems = await api("GET", "media?kind=video"); }
  catch { videoItems = []; }

  const grid = $("vidGallery");
  grid.innerHTML = "";
  if (!videoItems.length) {
    grid.innerHTML = '<div class="gallery-empty">No videos yet. Describe one above and press Generate.</div>';
  }

  for (const item of videoItems) {
    const card = document.createElement("div");
    card.className = "clip";
    const done = item.status === "completed" && item.files.length;

    if (done) {
      const video = document.createElement("video");
      video.src = `/api/media/${encodeURIComponent(item.id)}/0`;
      video.controls = true;
      video.preload = "metadata";
      card.appendChild(video);
    } else {
      const waiting = document.createElement("div");
      waiting.className = "clip-waiting";
      waiting.innerHTML = `<span class="badge ${item.status}">${(item.status || "").replace("_", " ")}</span>`;
      card.appendChild(waiting);
    }

    const body = document.createElement("div");
    body.className = "clip-body";

    const prompt = document.createElement("div");
    prompt.className = "clip-prompt";
    prompt.textContent = item.prompt || "(no prompt)";
    body.appendChild(prompt);

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    const bits = [item.model];
    if (item.cost) bits.push("$" + Number(item.cost).toFixed(2));
    for (const [k, v] of Object.entries(item.params || {})) bits.push(k === "duration" ? v + "s" : String(v));
    bits.push(new Date(item.created).toLocaleString());
    meta.textContent = bits.filter(Boolean).join("  ·  ");
    body.appendChild(meta);

    if (item.error) {
      const problem = document.createElement("div");
      problem.className = "clip-error";
      problem.textContent = item.error;
      body.appendChild(problem);
    }

    const actions = document.createElement("div");
    actions.className = "clip-actions";
    if (done) {
      const download = document.createElement("button");
      download.innerHTML = iconSvg("file", 14) + " Download";
      download.onclick = () => {
        window.location.href = `/api/media/${encodeURIComponent(item.id)}/0?download=1`;
      };
      actions.appendChild(download);
    }
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.innerHTML = iconSvg("trash", 14) + " Delete";
    remove.onclick = async () => {
      if (!confirm("Delete this video? This can't be undone.")) return;
      try { await api("DELETE", "media/" + encodeURIComponent(item.id)); await loadVideoGallery(); }
      catch (err) { toast(err.message); }
    };
    actions.appendChild(remove);
    body.appendChild(actions);

    card.appendChild(body);
    grid.appendChild(card);
  }

  // Keep refreshing only while something is actually being made.
  const running = videoItems.some(v => v.status === "pending" || v.status === "in_progress");
  stopVideoPolling();
  if (running && currentTab === "video") videoTimer = setInterval(loadVideoGallery, 5000);
}

/* ======================= stats toggles + context bar ======================= */
/* Each pill shows or hides one feature; the choice is remembered per browser. */
function applyToggles() {
  for (const [name, on] of Object.entries(toggles)) {
    const pill = document.querySelector(`.pill[data-toggle="${name}"]`);
    if (pill) pill.classList.toggle("on", on);
  }
  $("statTokens").hidden = !toggles.tokens;
  $("statSpeed").hidden = !toggles.speed;
  $("contextWrap").hidden = !toggles.context;
  // The whole right panel disappears when it has nothing left to show.
  $("statsPanel").hidden = !toggles.tokens && !toggles.speed;
}

/* The three extra speed rows, each off until you switch it on. */
function applyExtras() {
  $("includeOllama").checked = includeOllama;
  document.querySelectorAll("[data-extra]").forEach(cb => { cb.checked = !!extras[cb.dataset.extra]; });
  $("rowPromptSpeed").hidden = !extras.promptSpeed;
  $("rowTtft").hidden = !extras.ttft;
  $("rowOrSpeed").hidden = !extras.orSpeed;
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return "—";
  return ms < 1000 ? Math.round(ms) + " ms" : (ms / 1000).toFixed(1) + " s";
}

/* Find the most recent reply in this chat that recorded the given measurement. */
function findStat(key) {
  if (!current) return null;
  for (let i = current.messages.length - 1; i >= 0; i--) {
    const stats = current.messages[i].stats;
    if (stats && stats[key] !== undefined && stats[key] !== null) return stats;
  }
  return null;
}

/* Speeds are saved with each reply, so they come back when an old chat is opened. */
function renderSpeed() {
  const measured = findStat("tps");            // Ollama reports its own real speed
  $("stTps").textContent = measured ? measured.tps.toFixed(1) : "—";
  $("stSpeedTokens").textContent = measured ? String(measured.out_tokens ?? "—") : "—";
  $("stGenTime").textContent = measured ? fmtMs(measured.gen_ms) : "—";

  const prompt = findStat("prompt_tps");
  $("stPromptTps").textContent = prompt ? prompt.prompt_tps.toFixed(0) + " tok/s" : "—";

  const first = findStat("ttft_ms");
  $("stTtft").textContent = first ? fmtMs(first.ttft_ms) : "—";

  const guess = findStat("tps_estimate");      // OpenRouter: timed here, so an estimate
  $("stOrTps").textContent = guess ? guess.tps_estimate.toFixed(1) + " tok/s" : "—";
}

/* ---- token counter: the totals for the open chat ---- */
/* Every reply saves what it used, so these are real counts, not guesses. */
function tokenTotals() {
  const totals = { input: 0, cached: 0, output: 0, reasoning: 0, cost: 0,
                   any: false, paid: false, reasoningEstimated: false };
  if (!current) return totals;
  for (const m of current.messages) {
    const used = m.usage;
    if (!used) continue;
    if (m.provider === "ollama" && !includeOllama) continue;   // its own toggle in the panel
    totals.any = true;
    if (m.provider !== "ollama") totals.paid = true;
    totals.input += used.prompt_tokens || 0;
    totals.output += used.completion_tokens || 0;
    totals.cached += used.prompt_tokens_details?.cached_tokens || 0;
    const details = used.completion_tokens_details || {};
    totals.reasoning += details.reasoning_tokens || 0;
    if (details.estimated && details.reasoning_tokens) totals.reasoningEstimated = true;
    totals.cost += Number(used.cost) || 0;
  }
  return totals;
}

function fmtCost(amount) {
  if (!amount) return "$0.00";
  return amount < 0.01 ? "$" + amount.toFixed(4) : "$" + amount.toFixed(2);
}

function renderTokens() {
  const t = tokenTotals();
  $("stInput").textContent = t.any ? fmtTokens(t.input) : "—";
  $("stCached").textContent = t.any ? fmtTokens(t.cached) : "—";
  $("stOutput").textContent = t.any ? fmtTokens(t.output) : "—";
  // a "~" when some of it was worked out rather than reported
  $("stReason").textContent = t.any
    ? (t.reasoningEstimated && t.reasoning ? "~" : "") + fmtTokens(t.reasoning)
    : "—";
  // Models on your own computer cost nothing, so saying "$0.00" would be misleading.
  $("stCost").textContent = !t.any ? "—" : (t.paid ? fmtCost(t.cost) : "free");
}

/* ---- context bar: how full the model's memory is ---- */
function contextMax() {
  if (provider === "ollama") return Number(settings.ollama_num_ctx) || 8192;
  const chosen = models.find(m => m.id === (settings.model || ""));
  return chosen?.context_length || null;      // unknown until the model list has loaded
}

function lastUsage() {
  if (!current) return null;
  for (let i = current.messages.length - 1; i >= 0; i--) {
    if (current.messages[i].usage) return current.messages[i].usage;
  }
  return null;
}

function updateContextBar() {
  if (!current) return;
  const max = contextMax();

  // What the next request will carry: the last one's input plus its reply.
  // Before any reply exists, guess from the text at about 4 characters a token.
  const last = lastUsage();
  let used, estimated = false;
  if (last) {
    used = (last.prompt_tokens || 0) + (last.completion_tokens || 0);
  } else {
    const chars = current.messages.reduce((n, m) => n + (m.content?.length || 0), 0) +
                  (character?.system?.length || 0);
    used = Math.round(chars / 4);
    estimated = true;
  }

  $("contextLabel").textContent =
    `${estimated ? "~" : ""}${fmtTokens(used)} / ${max ? fmtTokens(max) : "—"} context`;

  const share = max ? used / max : 0;
  const fill = $("contextFill");
  fill.style.width = Math.min(100, share * 100) + "%";
  fill.classList.toggle("warn", share >= 0.7 && share < 0.9);
  fill.classList.toggle("danger", share >= 0.9);

  // Ollama silently drops the oldest messages once the window is full, so this
  // matters more there than with OpenRouter, which simply refuses.
  const warn = provider === "ollama" && max && share >= 0.9;
  $("contextWarning").hidden = !warn;
  if (warn) {
    $("contextWarning").textContent =
      "Ollama will start forgetting the beginning of this chat. Start a new chat, " +
      "or raise the context size in Settings.";
  }
}

/* ======================= samkoBuilds watermark ======================= */
/* If the owner has put the monogram in assets/, use it for the watermark and
   the browser-tab icon. If not, the "sB" text fallback already in the HTML
   stays - we never draw a stand-in logo of our own. */
async function initWatermark() {
  // SVG is preferred (it stays sharp at any size); a PNG is used if that is what exists.
  for (const file of ["assets/samkobuilds-monogram.svg", "assets/samkobuilds-monogram.png"]) {
    try {
      const r = await fetch(file, { method: "HEAD" });
      if (!r.ok) continue;
      // Height only, so the mark is always scaled proportionally.
      $("wmMark").innerHTML = `<img src="${file}" alt="samkoBuilds" height="26">`;
      $("favicon").href = file;
      return;
    } catch {}
  }
  console.info(
    "[samkoBuilds] No assets/samkobuilds-monogram.svg or .png found, so the watermark is using " +
    "the 'sB' text fallback. Drop the logo file into the assets/ folder to use the real mark."
  );
}

/* ======================= UI wiring ======================= */
function renderTop() {
  $("modelChip").textContent = settings.model || "openrouter/auto";
  if (provider === "ollama") {
    $("keyDot").classList.toggle("off", ollamaReachable !== true);
    $("topSub").textContent = ollamaReachable === true
      ? (settings.ollama_model || "No model chosen")
      : "Ollama not reachable";
  } else {
    $("keyDot").classList.toggle("off", !settings.connected);
    $("topSub").textContent = settings.connected ? "Connected" : "Not connected — open Settings";
  }
}
function renderAll() { renderTop(); renderChatList(); renderMessages(); }

$("form").onsubmit = e => {
  e.preventDefault();
  if (controller) { controller.abort(); return; }   // the button acts as Stop while answering
  const text = $("input").value.trim();
  const ready = pending.filter(p => p.url);          // skip any still uploading
  if ((!text && !ready.length) || !character) return;
  if (!modelTakesImages() && ready.length) {
    toast("This model can't look at pictures — pick one that can.");
    return;
  }
  if (!current.messages.length) {
    const title = text || (ready.length ? "Picture" : "New chat");
    current.title = title.length > 42 ? title.slice(0, 42) + "…" : title;
  }
  const outgoing = { role: "user", content: text };
  if (ready.length) outgoing.images = ready.map(({ id, url, media_type }) => ({ id, url, media_type }));
  current.messages.push(outgoing);
  pending = [];
  renderAttachments();
  $("input").value = "";
  autoGrow();
  persist(current);
  if ($("inner").querySelector(".welcome")) $("inner").innerHTML = "";
  addMessageEl(current.messages.at(-1));
  renderChatList();
  updateContextBar();
  ask();
};

const input = $("input");
function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
}
input.addEventListener("input", autoGrow);
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); }
});

/* ---- attaching pictures: a button, a paste, or a drag and drop ---- */
$("attachBtn").onclick = () => $("imageInput").click();
$("imageInput").onchange = e => {
  for (const file of e.target.files) attachImage(file);
  e.target.value = "";
};
input.addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length) return;
  e.preventDefault();                      // keep the file name out of the text box
  files.forEach(attachImage);
});
const chatView = $("viewChat");
chatView.addEventListener("dragover", e => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
chatView.addEventListener("drop", e => {
  const files = [...(e.dataTransfer?.files || [])].filter(f => f.type.startsWith("image/"));
  if (!files.length) return;
  e.preventDefault();
  files.forEach(attachImage);
});

$("newChatBtn").onclick = () => {
  if (controller) return;
  current = newChat();
  pending = []; renderAttachments();
  renderAll(); closeSidebar(); input.focus();
};
$("characterSelect").onchange = e => {
  if (controller) controller.abort();
  switchCharacter(e.target.value);
  closeSidebar();
};
$("filesBtn").onclick = () => openFiles();

document.querySelectorAll(".tab").forEach(t => { t.onclick = () => switchTab(t.dataset.tab); });

document.querySelectorAll(".pill").forEach(p => {
  p.onclick = () => {
    const name = p.dataset.toggle;
    toggles[name] = !toggles[name];
    store.set("lc_toggles", toggles);
    applyToggles();
  };
});

document.querySelectorAll("[data-extra]").forEach(cb => {
  cb.onchange = () => {
    extras[cb.dataset.extra] = cb.checked;
    store.set("lc_speed_extras", extras);
    applyExtras();
  };
});

document.querySelectorAll(".prov").forEach(b => { b.onclick = () => setProvider(b.dataset.provider); });
$("ollamaModelSelect").onchange = e => saveOllamaModel(e.target.value);

/* ---- Video tab wiring ---- */
$("vidModel").onchange = e => chooseVideoModel(e.target.value);
$("vidGenerate").onclick = generateVideo;

/* ---- Image tab wiring ---- */
$("imgModel").onchange = e => chooseImageModel(e.target.value);
$("imgGenerate").onclick = generateImage;
$("imgRefBtn").onclick = () => $("imgRefInput").click();
$("imgRefClear").onclick = clearReference;
$("imgRefInput").onchange = e => {
  const file = e.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => useReference(reader.result);   // a data URL, which is what OpenRouter takes
  reader.readAsDataURL(file);
  e.target.value = "";
};

$("viewerDownload").onclick = () => {
  if (!viewing) return;
  window.location.href = `/api/media/${encodeURIComponent(viewing.item.id)}/${viewing.index}?download=1`;
};
$("viewerCopy").onclick = () => {
  if (!viewing) return;
  navigator.clipboard?.writeText(viewing.item.prompt || "");
  toast("Prompt copied");
};
$("viewerUseRef").onclick = async () => {
  if (!viewing) return;
  try {
    const res = await fetch(`/api/media/${encodeURIComponent(viewing.item.id)}/${viewing.index}`);
    const blob = await res.blob();
    const reader = new FileReader();
    reader.onload = () => {
      useReference(reader.result);
      closeModals();
      toast("Added as a reference image");
    };
    reader.readAsDataURL(blob);
  } catch { toast("Couldn't use that image"); }
};
$("viewerDelete").onclick = async () => {
  if (!viewing) return;
  if (!confirm("Delete this image? This can't be undone.")) return;
  try {
    await api("DELETE", "media/" + encodeURIComponent(viewing.item.id));
    closeModals();
    await loadGallery();
    toast("Deleted");
  } catch (err) { toast(err.message); }
};

$("includeOllama").onchange = e => {
  includeOllama = e.target.checked;
  store.set("lc_include_ollama", includeOllama);
  renderTokens();
};

$("lanDismiss").onclick = () => {
  $("lanBanner").hidden = true;
  document.body.classList.remove("has-banner");
  store.set("lc_lan_banner_hidden", true);
};

function openModal(id) { $(id).classList.add("open"); }
function closeModals() { document.querySelectorAll(".overlay").forEach(o => o.classList.remove("open")); }
document.querySelectorAll(".overlay").forEach(o => o.addEventListener("click", e => {
  if (e.target === o || e.target.hasAttribute("data-close")) closeModals();
}));
document.addEventListener("keydown", e => { if (e.key === "Escape") closeModals(); });

/* ---- the Settings screen ---- */
function openSettings() {
  renderSettingsCard();
  setHelp("");
  $("ollamaUrl").value = settings.ollama_url || "";
  $("ollamaCtx").value = settings.ollama_num_ctx || 8192;
  $("olHelp").innerHTML = "";
  openModal("settingsModal");
  loadModels();
  showOllamaStatus();
}

/* ---- the Ollama part of Settings ---- */
function setOllamaStatus(text, connected) {
  $("olDot").classList.toggle("off", !connected);
  $("olStatus").textContent = text;
}
async function showOllamaStatus() {
  setOllamaStatus("Checking…", false);
  const result = await checkOllama();
  if (!result.ok) {
    setOllamaStatus("Not reachable", false);
    $("olHelp").innerHTML = result.html;
    $("olHelp").className = "help bad";
    return;
  }
  setOllamaStatus(ollamaModels.length + " model" + (ollamaModels.length === 1 ? "" : "s") + " found", true);
  const chosen = $("ollamaModelSetting").value;
  const max = chosen ? await ollamaModelContext(chosen) : null;
  $("olHelp").className = "help";
  $("olHelp").textContent = max
    ? `${chosen} can go up to ${fmtTokens(max)} tokens of context. Local models use memory for this, so raise num_ctx only as far as you need.`
    : "Ollama keeps only the newest messages once the context size is full.";
}
$("olTestBtn").onclick = async () => {
  try { settings = await api("PUT", "settings", { ollama_url: $("ollamaUrl").value.trim() }); } catch {}
  await showOllamaStatus();
};
$("ollamaModelSetting").onchange = async e => {
  await saveOllamaModel(e.target.value);
  await showOllamaStatus();
};
$("settingsBtn").onclick = openSettings;
$("modelChip").onclick = openModelPicker;         // the chip jumps straight to the model list
$("browseModelsBtn").onclick = openModelPicker;
$("modelSearch").oninput = renderModelRows;
document.querySelectorAll("[data-tool]").forEach(box => { box.onchange = saveToolToggles; });

$("connectBtn").onclick = async () => {
  setHelp("Opening OpenRouter…");
  try {
    const r = await api("GET", "openrouter/connect");
    window.location.href = r.url;          // OpenRouter sends you straight back here afterwards
  } catch (err) {
    setHelp("Couldn't start the sign-in: " + err.message, "bad");
  }
};

$("pasteBtn").onclick = $("replaceBtn").onclick = () => {
  $("pasteRow").hidden = false;
  $("keyInput").value = "";
  $("keyInput").focus();
};

$("saveKeyBtn").onclick = async () => {
  const key = $("keyInput").value.trim();
  if (!key) { setHelp("Paste a key first.", "bad"); return; }
  try {
    settings = await api("PUT", "settings", { openrouter_key: key });
    $("keyInput").value = "";
    $("pasteRow").hidden = true;
    renderSettingsCard();
    renderTop();
    setHelp("Key saved. Press Test to check it works.", "good");
  } catch (err) {
    setHelp("Couldn't save the key: " + err.message, "bad");
  }
};

$("testBtn").onclick = async () => {
  setHelp("Checking…");
  try {
    const r = await api("GET", "openrouter/test");
    if (!r.ok) { setHelp("That key did not work: " + r.error, "bad"); return; }
    const spent = r.usage === null || r.usage === undefined ? null : Number(r.usage);
    let text = "The key works" + (r.label ? ` (${r.label})` : "") + ".";
    if (spent !== null) text += ` $${spent.toFixed(2)} spent on it so far.`;
    if (r.limit) text += ` Its limit is $${r.limit}.`;
    setHelp(text, "good");
  } catch (err) {
    setHelp(err.message, "bad");
  }
};

$("disconnectBtn").onclick = async () => {
  if (!confirm("Remove the OpenRouter key from this computer?")) return;
  try {
    settings = await api("DELETE", "openrouter/key");
    renderSettingsCard();
    renderTop();
    setHelp("Key removed.", "good");
  } catch (err) {
    setHelp(err.message, "bad");
  }
};

$("saveSettings").onclick = async () => {
  try {
    settings = await api("PUT", "settings", {
      ollama_url: $("ollamaUrl").value.trim() || "http://localhost:11434",
      ollama_num_ctx: Number($("ollamaCtx").value) || 8192,
      ollama_model: $("ollamaModelSetting").value || ""
    });
    renderTop();
    refreshStats();
    closeModals();
    toast("Settings saved");
  } catch (err) {
    setHelp("Couldn't save: " + err.message, "bad");
  }
};

$("promptBtn").onclick = async () => {
  if (!character) return;
  const sys = await fetchSystem(character.id);
  character.system = sys.prompt;
  const about = sys.user_source === "character" ? `characters/${character.id}/user.md`
              : sys.user_source === "global" ? "user.md"
              : "none yet";
  $("promptDesc").textContent =
    `Built by the server from characters/${character.id}/identity.md and instructions.md. ` +
    `About the user: ${about}`;
  $("promptView").textContent = sys.prompt || "(empty — there is nothing in identity.md yet)";
  openModal("promptModal");
};

/* ======================= the file editor ======================= */
/* Only the fixed set of files can be opened here: the global user.md, and the
   current character's identity.md, instructions.md and (optional) user.md. */
let editorCharacterId = null;
let editorFile = { scope: "character", kind: "identity" };
let previewing = false;

function setEditorHelp(text, kind) {
  const el = $("editorHelp");
  el.textContent = text || "";
  el.className = "help" + (kind ? " " + kind : "");
}

function fileUrl(scope, kind) {
  return scope === "global"
    ? "md/global/user"
    : "md/character/" + encodeURIComponent(editorCharacterId) + "/" + kind;
}

async function openFiles() {
  if (!characterNames.length) return;
  editorCharacterId = character?.id || characterNames[0];
  const sel = $("editorCharacter");
  sel.innerHTML = "";
  for (const n of characterNames) {
    const o = document.createElement("option");
    o.value = n; o.textContent = titleCase(n);
    sel.appendChild(o);
  }
  sel.value = editorCharacterId;
  openModal("filesModal");
  await refreshOverride();
  await openFile("character", "identity");
}

async function refreshOverride() {
  let info = { override: false };
  try { info = await api("GET", "characters/" + encodeURIComponent(editorCharacterId) + "/info"); }
  catch {}
  $("overrideToggle").checked = !!info.override;
  $("characterUserFile").hidden = !info.override;

  const picture = $("editorAvatar");
  if (info.avatar) picture.innerHTML = `<img src="${info.avatar}" alt="">`;
  else picture.innerHTML = `<span class="char-initial">${titleCase(editorCharacterId).charAt(0)}</span>`;
  $("avatarClearBtn").hidden = !info.avatar;
  return info;
}

/* After a picture changes, redraw the chat too if it's the character you're talking to. */
async function afterAvatarChange() {
  await refreshOverride();
  if (character && character.id === editorCharacterId) {
    character = await loadCharacter(character.id);
    renderAll();
  }
}

async function openFile(scope, kind) {
  editorFile = { scope, kind };
  const marker = scope === "global" ? "global" : kind;
  document.querySelectorAll(".file-item").forEach(b => b.classList.toggle("active", b.dataset.file === marker));
  setEditorHelp("");
  try {
    const f = await api("GET", fileUrl(scope, kind));
    $("editorText").value = f.content;
    $("editorPath").textContent = f.path + (f.exists ? "" : "  (not created yet)");
    $("undoBtn").disabled = !f.has_backup;
    showPreview(false);
  } catch (err) {
    setEditorHelp(err.message, "bad");
  }
}

function showPreview(on) {
  previewing = on;
  $("previewBtn").classList.toggle("on", on);
  $("editorPreview").hidden = !on;
  $("editorText").hidden = on;
  if (on) $("editorPreview").innerHTML = md($("editorText").value || "*(empty)*");
}

/* After any file change, rebuild the prompt we keep for the viewer and the
   context estimate. The next message fetches it again anyway. */
async function afterFilesChanged() {
  if (!character) return;
  const sys = await fetchSystem(character.id);
  character.system = sys.prompt;
  character.userSource = sys.user_source;
  refreshStats();
}

document.querySelectorAll(".file-item").forEach(b => {
  b.onclick = () => openFile(b.dataset.file === "global" ? "global" : "character", b.dataset.file);
});

/* ---- character pictures ---- */
$("editorAvatar").onclick = $("avatarPickBtn").onclick = () => $("avatarInput").click();
$("avatarInput").onchange = e => {
  const file = e.target.files?.[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await api("PUT", "characters/" + encodeURIComponent(editorCharacterId) + "/avatar",
                { image: reader.result });
      await afterAvatarChange();
      setEditorHelp("Picture updated.", "good");
    } catch (err) {
      setEditorHelp(err.message, "bad");
    }
  };
  reader.readAsDataURL(file);
};
$("avatarClearBtn").onclick = async () => {
  try {
    await api("DELETE", "characters/" + encodeURIComponent(editorCharacterId) + "/avatar");
    await afterAvatarChange();
    setEditorHelp("Picture removed.", "good");
  } catch (err) { setEditorHelp(err.message, "bad"); }
};

$("editorCharacter").onchange = async e => {
  editorCharacterId = e.target.value;
  await refreshOverride();
  await openFile("character", "identity");
};

$("previewBtn").onclick = () => showPreview(!previewing);

$("saveFileBtn").onclick = async () => {
  try {
    const f = await api("PUT", fileUrl(editorFile.scope, editorFile.kind), { content: $("editorText").value });
    $("editorPath").textContent = f.path;
    $("undoBtn").disabled = !f.has_backup;
    setEditorHelp("Saved. It applies to your next message.", "good");
    await afterFilesChanged();
  } catch (err) {
    setEditorHelp("Couldn't save: " + err.message, "bad");
  }
};

$("undoBtn").onclick = async () => {
  try {
    const f = await api("POST", fileUrl(editorFile.scope, editorFile.kind) + "/undo", {});
    $("editorText").value = f.content;
    if (previewing) showPreview(true);
    setEditorHelp("Put the previous version back. Press Undo again to swap them round.", "good");
    await afterFilesChanged();
  } catch (err) {
    setEditorHelp(err.message, "bad");
  }
};

$("overrideToggle").onchange = async e => {
  const on = e.target.checked;
  if (!on && !confirm("Delete this character's own user.md and go back to the global one?")) {
    e.target.checked = true;
    return;
  }
  try {
    await api("PUT", "characters/" + encodeURIComponent(editorCharacterId) + "/override", { on });
    await refreshOverride();
    if (on) await openFile("character", "user");
    else if (editorFile.scope === "character" && editorFile.kind === "user") await openFile("character", "identity");
    await afterFilesChanged();
    setEditorHelp(on ? "Made a copy of your global user.md for this character."
                     : "Back to the global user.md. A copy of the old one is kept in data/.backup.", "good");
  } catch (err) {
    e.target.checked = !on;
    setEditorHelp(err.message, "bad");
  }
};

/* ---- new character ---- */
function slugify(text) {
  return (text || "").trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function updateSlugHint() {
  const slug = slugify($("newCharacterName").value);
  $("newCharacterHint").textContent = slug
    ? "Saved as characters/" + slug + "/"
    : "Letters and numbers, for example Code Helper.";
}
$("newCharacterBtn").onclick = () => {
  $("newCharacterName").value = "";
  updateSlugHint();
  openModal("newCharacterModal");
  $("newCharacterName").focus();
};
$("newCharacterName").oninput = updateSlugHint;
$("newCharacterName").onkeydown = e => { if (e.key === "Enter") $("createCharacterBtn").click(); };
$("createCharacterBtn").onclick = async () => {
  try {
    const made = await api("POST", "characters", { name: $("newCharacterName").value });
    closeModals();
    await initCharacters(made.id);        // switch the whole app to the new character
    await openFiles();                  // and reopen the editor on its identity.md
    setEditorHelp("Created. Write who this character is, then press Save.", "good");
  } catch (err) {
    $("newCharacterHint").textContent = err.message;
  }
};

/* ---- delete character ---- */
$("deleteCharacterBtn").onclick = async () => {
  const name = titleCase(editorCharacterId);
  let chats = 0;
  try { chats = (await api("GET", "characters/" + encodeURIComponent(editorCharacterId) + "/info")).chats; }
  catch {}
  $("deleteTitle").textContent = `Delete character ${name}?`;
  $("deleteText").textContent =
    `This permanently deletes ${name}'s files and all ${chats} chat${chats === 1 ? "" : "s"} ` +
    `with ${name}. This can't be undone. Are you sure?`;
  openModal("deleteCharacterModal");
};
$("confirmDeleteBtn").onclick = async () => {
  try {
    await api("DELETE", "characters/" + encodeURIComponent(editorCharacterId));
    closeModals();
    toast("Character deleted");
    await initCharacters();
  } catch (err) {
    $("deleteText").textContent = err.message;
  }
};

const sidebar = $("sidebar");
$("menuBtn").onclick = () => sidebar.classList.toggle("open");
function closeSidebar() { sidebar.classList.remove("open"); }

/* ---- coming back from the OpenRouter sign-in ---- */
function handleConnectResult() {
  const params = new URLSearchParams(location.search);
  const ok = params.get("connected");
  const failed = params.get("connect_error");
  if (!ok && !failed) return;
  history.replaceState({}, "", location.pathname);   // tidy the address bar
  if (ok) {
    toast("Connected ✓");
  } else {
    openSettings();
    setHelp(failed, "bad");
  }
}

/* ---- one-time offer to move an API key out of this browser ---- */
async function offerKeyMigration() {
  if (settings.connected) return;
  if (store.get("lc_key_migration_declined", false)) return;
  const old = store.get("lc_settings", null);
  const oldKey = old && typeof old.key === "string" ? old.key.trim() : "";
  if (!oldKey) return;

  openModal("migrateModal");
  $("migrateYes").onclick = async () => {
    try {
      settings = await api("PUT", "settings", { openrouter_key: oldKey, model: old.model });
      store.set("lc_settings", { model: old.model || "" });   // the key is gone, the model stays
      closeModals();
      renderTop();
      toast("Key moved into the app");
    } catch (err) {
      closeModals();
      toast("Couldn't move the key: " + err.message);
    }
  };
  $("migrateNo").onclick = () => {
    store.set("lc_key_migration_declined", true);
    closeModals();
  };
}

/* ======================= start up ======================= */
drawIcons();         // turn every <span data-icon="…"> into a real SVG icon
applyToggles();
applyExtras();

(async function start() {
  await loadStatus();
  await loadSettings();
  handleConnectResult();
  await offerKeyMigration();
  initWatermark();
  renderProvider();
  checkOllama();     // in the background: it only decides whether Ollama is offered
  // Also in the background: the model list tells the context bar how big the
  // chosen OpenRouter model's memory is. The server keeps it for 10 minutes.
  if (settings.connected) loadModels();
  await migrateOldChats();
  await initCharacters();
})();
