/* ═══════════════════════════════════════════════
   ASH — AI Chatbot Engine
   Dialogue state-machine with personality
   ═══════════════════════════════════════════════ */

const $messages = document.getElementById('messages');
const $container = document.getElementById('chatContainer');
const $input = document.getElementById('userInput');
const $sendBtn = document.getElementById('sendBtn');
const $sidebar = document.getElementById('sidebar');

/* ── Conversation state ──────────────────── */
let conversationState = 'idle';
let pendingTealiumType = null;
let lastScanData = null; // stores last URL scan results for LLM context

/* ── API key helper ────────────────────── */

/* ── ASH's mini-avatar SVG for message bubbles ── */
const ASH_MINI = `<img src="ash-avatar.svg" alt="ASH" width="28" height="28" style="border-radius:50%;object-fit:cover;" />`;

/* ═══════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════ */
window.addEventListener('DOMContentLoaded', () => {
    spawnParticles();
    addBotMessage(welcomeMessage());
    $input.focus();
});

/* Event listeners */
$sendBtn.addEventListener('click', handleSend);
$input.addEventListener('keydown', e => { if (e.key === 'Enter') handleSend(); });

// Sidebar nav
document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const action = btn.dataset.action;
        if (action === 'analyze') startAnalyzeFlow();
        if (action === 'tealium') startTealiumFlow();
        if (action === 'scanner') startScannerFlow();
        if (action === 'chat') { closeScannerPanel(); addBotMessage(welcomeMessage()); }
        closeSidebar();
    });
});

// Quick chips
document.querySelectorAll('.chip').forEach(btn => {
    btn.addEventListener('click', () => {
        const action = btn.dataset.action;
        if (action === 'analyze') startAnalyzeFlow();
        if (action === 'tealium') startTealiumFlow();
        if (action === 'scanner') startScannerFlow();
        if (action === 'help') addBotMessage(helpMessage());
    });
});

// Clear chat
document.getElementById('clearChat').addEventListener('click', () => {
    $messages.innerHTML = '';
    conversationState = 'idle';
    addBotMessage(welcomeMessage());
});

// Mobile sidebar toggle
document.getElementById('menuToggle').addEventListener('click', () => {
    $sidebar.classList.toggle('open');
});
function closeSidebar() { $sidebar.classList.remove('open'); }

/* ═══════════════════════════════════════════════
   MESSAGE ROUTING
   ═══════════════════════════════════════════════ */
function handleSend() {
    const text = $input.value.trim();
    if (!text) return;
    $input.value = '';
    addUserMessage(text);

    switch (conversationState) {
        case 'awaiting_url': analyzeURL(text); break;
        case 'awaiting_tealium_type': handleTealiumType(text); break;
        case 'awaiting_tealium_details': handleTealiumDetails(text); break;
        default: routeIdleMessage(text);
    }
}

function routeIdleMessage(text) {
    if (looksLikeURL(text)) return analyzeURL(text);

    if (/\b(tealium|utag|tracking|tag|analytics|script|data.?layer)\b/i.test(text)) {
        if (lastScanData) return chatWithLLM(text);
        return startTealiumFlow();
    }
    if (/\b(analyze|scan|check|inspect|scrape|detect|find)\b/i.test(text)) return startAnalyzeFlow();
    if (/\b(hi|hello|hey|hola|sup|yo)\b/i.test(text)) return addBotMessage(greetingReply());
    
    // Always use LLM since it's local Ollama
    return chatWithLLM(text);
}

/* ═══════════════════════════════════════════════
   FLOW 1 — URL ANALYSIS
   ═══════════════════════════════════════════════ */
function startAnalyzeFlow() {
    conversationState = 'awaiting_url';
    addBotMessage(`
    <strong>🔍 Sure thing!</strong><br/>
    Drop the URL you want me to scan. I'll detect every <strong>button</strong>, <strong>link</strong>, <strong>form</strong>, and <strong>PDF</strong> on the page for you.
  `);
}

async function analyzeURL(url) {
    conversationState = 'idle';
    showTyping();
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();
        removeTyping();
        if (!res.ok || data.error) {
            addBotMessage(`<strong>⚠️ Oops!</strong> ${data.error || data.details || 'Could not reach that URL.'}<br/>Double-check the address and try again, yeah?`);
            return;
        }
        // Store scan data for LLM context
        lastScanData = data;
        addBotMessage(buildAnalysisResult(data));
    } catch (err) {
        removeTyping();
        addBotMessage(`<strong>❌ Network hiccup:</strong> ${err.message}`);
    }
}

function buildAnalysisResult(data) {
    const s = data.summary;
    let html = `
    <strong>📊 Here's what I found on</strong> <a href="${data.url}" target="_blank" style="color:var(--cyan);text-decoration:none">${data.pageTitle || data.url}</a>
    ${data.metaDescription ? `<br/><span style="color:var(--text-muted);font-size:12px">${data.metaDescription.substring(0, 130)}</span>` : ''}
    <div class="analysis-result">
      <div class="result-summary">
        <div class="stat-card"><div class="stat-number">${s.totalLinks}</div><div class="stat-label">Links</div></div>
        <div class="stat-card"><div class="stat-number">${s.totalButtons}</div><div class="stat-label">Buttons</div></div>
        <div class="stat-card"><div class="stat-number">${s.totalForms}</div><div class="stat-label">Forms</div></div>
        <div class="stat-card"><div class="stat-number">${s.totalPDFs}</div><div class="stat-label">PDFs</div></div>
      </div>`;
    if (data.links.length) html += buildAccordion('🔗 Links', data.links.length, buildLinksTable(data.links));
    if (data.buttons.length) html += buildAccordion('🔘 Buttons', data.buttons.length, buildButtonsTable(data.buttons));
    if (data.forms.length) html += buildAccordion('📝 Forms', data.forms.length, buildFormsHTML(data.forms));
    if (data.pdfs.length) html += buildAccordion('📄 PDFs', data.pdfs.length, buildPDFsTable(data.pdfs));
    html += `</div><br/><span style="color:var(--text-muted);font-size:12px">Now you can ask me to <strong>tag any specific element</strong> — e.g. "tag the login button". 🧠 Ollama Local AI active! 🚀</span>`;
    return html;
}



/* ═══════════════════════════════════════════════
   FLOW 3 — TEALIUM SCRIPT
   ═══════════════════════════════════════════════ */
function startTealiumFlow() {
    conversationState = 'awaiting_tealium_type';
    addBotMessage(`
    <strong>📦 Tealium Script Generator</strong><br/>
    What event type do you want to track?
    <div class="element-choices">
      <button class="el-choice-btn" onclick="selectTealiumType('page_view')">📄 Page View</button>
      <button class="el-choice-btn" onclick="selectTealiumType('click')">🖱️ Click</button>
      <button class="el-choice-btn" onclick="selectTealiumType('form_submit')">📝 Form Submit</button>
      <button class="el-choice-btn" onclick="selectTealiumType('download')">⬇️ Download</button>
      <button class="el-choice-btn" onclick="selectTealiumType('video')">🎬 Video</button>
      <button class="el-choice-btn" onclick="selectTealiumType('ecommerce')">🛒 E-Commerce</button>
      <button class="el-choice-btn" onclick="selectTealiumType('scroll')">📜 Scroll</button>
    </div>
  `);
}

window.selectTealiumType = function (type) {
    addUserMessage(type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
    handleTealiumType(type);
};

function handleTealiumType(text) {
    const type = extractTealiumType(text);
    pendingTealiumType = type;
    conversationState = 'awaiting_tealium_details';
    addBotMessage(`
    <strong>Got it — <code>${type}</code> tracking! 🎯</strong><br/>
    Any specifics I should include?<br/>
    • Page name, element ID, label<br/>
    • Product name / price (for e-commerce)<br/><br/>
    Or say <strong>"use defaults"</strong> and I'll give you a template with placeholders.
  `);
}

async function handleTealiumDetails(text) {
    conversationState = 'idle';
    const details = parseTealiumDetails(text, pendingTealiumType);
    showTyping();
    try {
        const res = await fetch('/api/tealium', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventType: pendingTealiumType, elementDetails: details })
        });
        const data = await res.json();
        removeTyping();
        if (!res.ok || data.error) { addBotMessage(`<strong>⚠️</strong> ${data.error}`); return; }
        addBotMessage(buildTealiumResult(data));
    } catch (err) { removeTyping(); addBotMessage(`<strong>❌</strong> ${err.message}`); }
}

function buildTealiumResult(data) {
    let html = `<strong>📦 Your Tealium Script — <code>${data.eventType}</code></strong><br/>`;
    html += `<br/><strong>📊 Data Layer Variables:</strong>`;
    html += `<div class="var-list">`;
    for (const k of Object.keys(data.variables)) html += `<span class="var-tag">${k}</span>`;
    html += `</div>`;
    html += buildCodeBlock('utag_data Setup', data.utagDataSetup);
    html += buildCodeBlock('Tracking Script', data.trackingScript);
    html += buildCodeBlock('Full HTML Snippet', data.fullSnippet);
    html += `<br/><span style="color:var(--text-muted);font-size:12px">Replace <code>{{placeholder}}</code> values with your real data. Need another one? I'm all ears! 🎧</span>`;
    return html;
}

/* ═══════════════════════════════════════════════
   UI RENDERING
   ═══════════════════════════════════════════════ */
function addBotMessage(html) {
    const wrap = document.createElement('div');
    wrap.className = 'message bot';
    wrap.innerHTML = `
    <div class="msg-avatar">${ASH_MINI}</div>
    <div class="bubble">${html}</div>
  `;
    $messages.appendChild(wrap);
    scrollBottom();
}

function addUserMessage(text) {
    const wrap = document.createElement('div');
    wrap.className = 'message user';
    wrap.innerHTML = `
    <div class="msg-avatar">U</div>
    <div class="bubble">${escapeHTML(text)}</div>
  `;
    $messages.appendChild(wrap);
    scrollBottom();
}

function showTyping() {
    const wrap = document.createElement('div');
    wrap.className = 'message bot';
    wrap.id = 'typingIndicator';
    wrap.innerHTML = `
    <div class="msg-avatar">${ASH_MINI}</div>
    <div class="bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>
  `;
    $messages.appendChild(wrap);
    scrollBottom();
}
function removeTyping() { document.getElementById('typingIndicator')?.remove(); }

function scrollBottom() {
    requestAnimationFrame(() => { $container.scrollTop = $container.scrollHeight; });
}

/* ── Code block ─────────────────────────── */
function buildCodeBlock(label, code) {
    const id = 'cb-' + Math.random().toString(36).slice(2, 9);
    return `
    <div class="code-block-wrapper">
      <div class="code-block-header">
        <span>${label}</span>
        <button class="copy-btn" onclick="copyCode('${id}')">Copy</button>
      </div>
      <pre class="code-block" id="${id}">${escapeHTML(code)}</pre>
    </div>`;
}
window.copyCode = function (id) {
    const block = document.getElementById(id);
    if (!block) return;
    navigator.clipboard.writeText(block.textContent).then(() => {
        const btn = block.closest('.code-block-wrapper').querySelector('.copy-btn');
        btn.textContent = '✓ Copied!';
        setTimeout(() => btn.textContent = 'Copy', 2000);
    });
};

/* ── Accordion ──────────────────────────── */
function buildAccordion(title, count, content) {
    const id = 'sec-' + Math.random().toString(36).slice(2, 9);
    return `
    <div class="result-section">
      <button class="section-toggle" onclick="toggleSection('${id}', this)">
        <span>${title} <span class="badge">${count}</span></span>
        <span class="chevron">▼</span>
      </button>
      <div class="section-content" id="${id}">${content}</div>
    </div>`;
}
window.toggleSection = function (id, btn) {
    const el = document.getElementById(id);
    const open = el.classList.toggle('open');
    btn.classList.toggle('open', open);
};

/* ── Tables ──────────────────────────────── */
function buildLinksTable(links) {
    let h = `<table class="data-table"><thead><tr><th>Text</th><th>URL</th><th>ID</th></tr></thead><tbody>`;
    for (const l of links.slice(0, 25)) {
        h += `<tr><td>${esc(l.text)}</td><td><a href="${esc(l.href)}" target="_blank">${esc(l.href).substring(0, 50)}</a></td><td>${esc(l.id)}</td></tr>`;
    }
    h += `</tbody></table>`;
    if (links.length > 25) h += `<p style="color:var(--text-muted);font-size:11px;margin-top:6px">…and ${links.length - 25} more</p>`;
    return h;
}
function buildButtonsTable(buttons) {
    let h = `<table class="data-table"><thead><tr><th>Text</th><th>Type</th><th>ID</th><th>Classes</th></tr></thead><tbody>`;
    for (const b of buttons.slice(0, 20)) h += `<tr><td>${esc(b.text)}</td><td>${esc(b.type)}</td><td>${esc(b.id)}</td><td>${esc(b.classes).substring(0, 40)}</td></tr>`;
    return h + `</tbody></table>`;
}
function buildFormsHTML(forms) {
    let h = '';
    for (const f of forms) {
        h += `<div style="margin-bottom:10px;padding:10px;background:rgba(255,255,255,0.02);border-radius:8px;border:1px solid var(--glass-border)">`;
        h += `<strong style="font-size:13px">Form${f.id ? ' #' + esc(f.id) : ''}</strong> — <code>${esc(f.method)}</code> → <code>${esc(f.action) || 'N/A'}</code>`;
        if (f.fields.length) {
            h += `<table class="data-table" style="margin-top:8px"><thead><tr><th>Field</th><th>Type</th><th>Name</th><th>Placeholder</th></tr></thead><tbody>`;
            for (const fd of f.fields) h += `<tr><td>${esc(fd.tag)}</td><td>${esc(fd.type)}</td><td>${esc(fd.name)}</td><td>${esc(fd.placeholder)}</td></tr>`;
            h += `</tbody></table>`;
        }
        h += `</div>`;
    }
    return h;
}
function buildPDFsTable(pdfs) {
    let h = `<table class="data-table"><thead><tr><th>Text</th><th>URL</th></tr></thead><tbody>`;
    for (const p of pdfs) h += `<tr><td>${esc(p.text)}</td><td><a href="${esc(p.href)}" target="_blank">${esc(p.href).substring(0, 60)}</a></td></tr>`;
    return h + `</tbody></table>`;
}

/* ═══════════════════════════════════════════════
   PARSING
   ═══════════════════════════════════════════════ */
function looksLikeURL(t) { return /^(https?:\/\/|www\.)/i.test(t.trim()) || /\.[a-z]{2,}(\/|$)/i.test(t.trim()); }



function extractTealiumType(text) {
    const l = text.toLowerCase().replace(/[_\s-]+/g, '_');
    for (const [re, t] of [[/page.?view/, 'page_view'], [/click/, 'click'], [/form/, 'form_submit'], [/download/, 'download'], [/video/, 'video'], [/e.?commerce|product|cart|purchase/, 'ecommerce'], [/scroll/, 'scroll']]) {
        if (re.test(l)) return t;
    }
    return 'click';
}



function parseTealiumDetails(text) {
    const d = {};
    if (/default/i.test(text)) return d;
    const pairs = text.match(/(\w+)\s*[=:]\s*["']?([^"'\n,]+)/g);
    if (pairs) for (const p of pairs) { const m = p.match(/(\w+)\s*[=:]\s*["']?([^"'\n,]+)/); if (m) d[m[1].replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '')] = m[2].trim(); }
    return d;
}

/* ── Util ────────────────────────────────── */
function escapeHTML(s) { return !s ? '' : String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
const esc = escapeHTML;

/* ═══════════════════════════════════════════════
   PARTICLES
   ═══════════════════════════════════════════════ */
function spawnParticles() {
    const box = document.getElementById('particles');
    for (let i = 0; i < 35; i++) {
        const p = document.createElement('div');
        p.className = 'particle';
        p.style.left = Math.random() * 100 + '%';
        p.style.animationDuration = (8 + Math.random() * 14) + 's';
        p.style.animationDelay = Math.random() * 10 + 's';
        p.style.width = p.style.height = (1 + Math.random() * 2) + 'px';
        p.style.opacity = 0.2 + Math.random() * 0.4;
        box.appendChild(p);
    }
}

/* ═══════════════════════════════════════════════
   ASH'S PERSONALITY MESSAGES
   ═══════════════════════════════════════════════ */
function welcomeMessage() {
    return `
    <strong>Heey! 👋 ASH this side!</strong><br/>
    <span style="color:var(--text-secondary)">How can I help you today?</span><br/><br/>
    Here's what I can do for you:<br/><br/>
    <strong>🔍 Analyze a URL</strong> — Drop any website link and I'll scan it for buttons, links, forms, and PDFs.<br/><br/>
    <strong>📦 Tealium Scripts</strong> — I generate <code>utag.link()</code> and <code>utag.view()</code> scripts with the right data-layer variables.<br/><br/>
    <span style="color:var(--text-muted);font-size:12.5px">Try pasting a URL, pick a quick action below, or just tell me what you need! ⚡</span>
  `;
}

function greetingReply() {
    const greetings = [
        `Heey! 😄 ASH here! What are we building today?`,
        `Yo! 👋 Good to see you! Paste a URL or tell me what element you need.`,
        `Hey hey! 🚀 ASH at your service. What can I do for you?`,
        `Hello there! 😎 Ready to analyze some websites or write some Tealium scripts?`
    ];
    return greetings[Math.floor(Math.random() * greetings.length)];
}

function helpMessage() {
    return `
    <strong>Here's everything I can do:</strong><br/><br/>
    🔍 <strong>URL Analysis</strong> — Paste a URL, I scan it and list all buttons, links, forms, and PDF files.<br/><br/>
    📦 <strong>Tealium Scripts</strong> — I build <code>utag.link()</code> / <code>utag.view()</code> scripts with suggested variables like <code>tealium_event</code>, <code>page_name</code>, <code>event_category</code>, etc.<br/><br/>
    <span style="color:var(--text-muted);font-size:12.5px">Just type naturally — I understand free text too! 🧠</span>
  `;
}

function fallbackMessage() {
    return `
    Hmm, I didn't quite catch that. 🤔 Here's what I can help with:<br/><br/>
    • <strong>Paste a URL</strong> to analyze its elements<br/>
    • Say <strong>"tealium script"</strong> to generate tracking code<br/><br/>
    💡 <strong>Pro tip:</strong> Chat with me naturally to unlock Ollama's local AI!
  `;
}

/* ═══════════════════════════════════════════════
   LLM CHAT — Gemini-powered responses
   ═══════════════════════════════════════════════ */
async function chatWithLLM(message) {
    showTyping();
    try {
        const res = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                context: lastScanData
            })
        });
        const data = await res.json();
        removeTyping();
        if (!res.ok || data.error) {
            addBotMessage(`<strong>⚠️</strong> ${data.error || 'Something went wrong with the AI.'}`);
            return;
        }
        addBotMessage(renderMarkdown(data.reply));
    } catch (err) {
        removeTyping();
        addBotMessage(`<strong>❌ Network error:</strong> ${err.message}`);
    }
}

/* ── Markdown to HTML renderer ────────── */
function renderMarkdown(md) {
    if (!md) return '';
    let html = md
        // Code blocks with language
        .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
            const id = 'c' + Math.random().toString(36).substr(2, 6);
            return `<div class="code-block"><div class="code-header"><span>${lang || 'code'}</span><button class="copy-btn" onclick="copyCode('${id}')">📋 Copy</button></div><pre id="${id}"><code>${escapeHTML(code.trim())}</code></pre></div>`;
        })
        // Inline code
        .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
        // Bold
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        // Headers
        .replace(/^### (.+)$/gm, '<h4 style="margin:12px 0 6px;color:var(--cyan)">$1</h4>')
        .replace(/^## (.+)$/gm, '<h3 style="margin:14px 0 8px;color:var(--purple-light)">$1</h3>')
        .replace(/^# (.+)$/gm, '<h2 style="margin:16px 0 10px">$1</h2>')
        // Bullet lists
        .replace(/^[\-\*] (.+)$/gm, '<li>$1</li>')
        // Numbered lists
        .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
        // Line breaks
        .replace(/\n\n/g, '<br/><br/>')
        .replace(/\n/g, '<br/>');
    // Wrap consecutive <li> tags in <ul>
    html = html.replace(/(<li>.*?<\/li>(<br\/>)?)+/g, match => {
        const items = match.replace(/<br\/>/g, '');
        return `<ul style="margin:8px 0;padding-left:20px">${items}</ul>`;
    });
    return html;
}

/* ── Settings modal ────────────────────── */
function openSettings() {
    const existing = document.getElementById('settingsModal');
    if (existing) { existing.remove(); return; }

    const currentKey = getApiKey();
    const masked = currentKey ? currentKey.substring(0, 8) + '...' + currentKey.slice(-4) : '';

    const modal = document.createElement('div');
    modal.id = 'settingsModal';
    modal.innerHTML = `
      <div class="settings-overlay" onclick="closeSettings()"></div>
      <div class="settings-panel">
        <div class="settings-header">
          <h3>⚙️ Settings</h3>
          <button onclick="closeSettings()" class="settings-close">✕</button>
        </div>
        <div class="settings-body">
          <label class="settings-label">Gemini API Key <span style="color:var(--text-muted);font-size:11px">(free)</span></label>
          <p style="color:var(--text-muted);font-size:12px;margin:0 0 8px">Get your free key at <a href="https://aistudio.google.com/apikey" target="_blank" style="color:var(--cyan)">Google AI Studio</a></p>
          <input type="password" id="apiKeyInput" placeholder="Enter your Gemini API key..." value="${currentKey}" class="settings-input" />
          ${masked ? `<p style="color:var(--text-muted);font-size:11px;margin:4px 0 0">Current: ${masked}</p>` : ''}
          <button onclick="saveApiKey()" class="settings-save">💾 Save Key</button>
          <div id="settingsStatus"></div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
}

function closeSettings() {
    const modal = document.getElementById('settingsModal');
    if (modal) modal.remove();
}

function saveApiKey() {
    const key = document.getElementById('apiKeyInput').value.trim();
    const status = document.getElementById('settingsStatus');
    if (!key) {
        localStorage.removeItem('ash_gemini_key');
        status.innerHTML = '<span style="color:#f87171">Key removed. Using template mode.</span>';
        updateLLMIndicator();
        return;
    }
    localStorage.setItem('ash_gemini_key', key);
    status.innerHTML = '<span style="color:#4ade80">✅ Key saved! AI mode activated.</span>';
    updateLLMIndicator();
    setTimeout(closeSettings, 1200);
}

function updateLLMIndicator() {
    const dot = document.getElementById('llmStatus');
    if (dot) {
        dot.style.background = getApiKey() ? '#4ade80' : '#64748b';
        dot.title = getApiKey() ? 'AI mode active' : 'Template mode — add API key in Settings';
    }
}

/* ═══════════════════════════════════════════════
   TAG SCANNER — Phase 1
   ═══════════════════════════════════════════════ */
let scannerData = null; // stores scanned elements
let selectedElementIdx = null;

function startScannerFlow() {
    const panel = document.getElementById('scannerPanel');
    const mainArea = document.querySelector('.main-area');
    panel.classList.add('active');
    mainArea.style.display = 'none';
    document.getElementById('scannerUrlInput').focus();
}

window.closeScannerPanel = function () {
    const panel = document.getElementById('scannerPanel');
    const mainArea = document.querySelector('.main-area');
    panel.classList.remove('active');
    mainArea.style.display = '';
    // Reset sidebar nav
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.getElementById('nav-chat').classList.add('active');
};

window.triggerScan = async function () {
    const urlInput = document.getElementById('scannerUrlInput');
    const url = urlInput.value.trim();
    if (!url) { urlInput.focus(); return; }

    const statusEl = document.getElementById('scannerStatus');
    const scanBtn = document.getElementById('scannerScanBtn');
    const treeEl = document.getElementById('scannerTree');

    statusEl.textContent = 'Scanning...';
    statusEl.className = 'scanner-status scanning';
    scanBtn.disabled = true;
    scanBtn.innerHTML = '<span class="scanner-spinner"></span> Scanning...';

    try {
        const res = await fetch('/api/scan-elements', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });
        const data = await res.json();

        if (!res.ok || data.error) {
            statusEl.textContent = 'Scan failed';
            statusEl.className = 'scanner-status error';
            treeEl.innerHTML = `<div class="scanner-error"><strong>⚠️ Error:</strong> ${data.error || data.details || 'Could not reach URL'}</div>`;
            return;
        }

        scannerData = data;
        statusEl.textContent = `${data.totalElements} elements found`;
        statusEl.className = 'scanner-status success';
        renderElementTree(data);
        // Reset inspector
        document.getElementById('inspectorContent').style.display = 'none';
        document.getElementById('inspectorEmptyState').style.display = '';
        selectedElementIdx = null;

    } catch (err) {
        statusEl.textContent = 'Network error';
        statusEl.className = 'scanner-status error';
        treeEl.innerHTML = `<div class="scanner-error"><strong>❌ Network error:</strong> ${err.message}</div>`;
    } finally {
        scanBtn.disabled = false;
        scanBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg> Scan`;
    }
};

// Allow Enter in scanner URL input
document.getElementById('scannerUrlInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') triggerScan();
});

function renderElementTree(data) {
    const treeEl = document.getElementById('scannerTree');
    const CATEGORY_META = {
        button: { icon: '🔘', label: 'Buttons', color: '#a78bfa' },
        link: { icon: '🔗', label: 'Links', color: '#38bdf8' },
        form: { icon: '📝', label: 'Forms', color: '#34d399' },
        input: { icon: '✏️', label: 'Inputs', color: '#fbbf24' },
        section: { icon: '📐', label: 'Sections', color: '#f472b6' },
        media: { icon: '🖼️', label: 'Media', color: '#fb923c' },
        heading: { icon: '🔤', label: 'Headings', color: '#c084fc' },
        other: { icon: '📦', label: 'Other', color: '#94a3b8' }
    };

    // Group by category
    const groups = {};
    for (const el of data.elements) {
        if (!groups[el.category]) groups[el.category] = [];
        groups[el.category].push(el);
    }

    // Page header
    let html = `
    <div class="scanner-page-info">
        <div class="scanner-page-title">${escapeHTML(data.pageTitle || data.url)}</div>
        <a class="scanner-page-url" href="${escapeHTML(data.url)}" target="_blank">${escapeHTML(data.url)}</a>
        <div class="scanner-counts">
            ${Object.entries(data.counts).map(([cat, cnt]) => {
                const meta = CATEGORY_META[cat] || CATEGORY_META.other;
                return `<span class="scanner-count-chip" style="--chip-color:${meta.color}">${meta.icon} ${cnt} ${meta.label}</span>`;
            }).join('')}
        </div>
    </div>
    <div class="scanner-filter-bar">
        <input type="text" id="scannerFilter" placeholder="🔍 Filter elements..." oninput="filterElements(this.value)" />
    </div>`;

    // Render each category group
    const categoryOrder = ['button', 'link', 'form', 'input', 'section', 'media', 'heading', 'other'];
    for (const cat of categoryOrder) {
        if (!groups[cat] || groups[cat].length === 0) continue;
        const meta = CATEGORY_META[cat] || CATEGORY_META.other;
        const groupId = 'grp-' + cat;
        html += `
        <div class="scanner-group">
            <button class="scanner-group-toggle open" onclick="toggleScannerGroup('${groupId}', this)">
                <span>${meta.icon} ${meta.label} <span class="scanner-group-count" style="background:${meta.color}">${groups[cat].length}</span></span>
                <span class="chevron">▼</span>
            </button>
            <div class="scanner-group-items open" id="${groupId}">`;

        for (const el of groups[cat]) {
            const preview = el.text || el.href || el.name || `<${el.tag}>`;
            const classBadge = el.classes ? `<span class="el-badge el-badge-class">.${escapeHTML(el.classes.split(' ')[0])}</span>` : '';
            const uniqueBadge = el.hasUniqueClass
                ? `<span class="el-badge el-badge-unique">🟢 UNIQUE</span>`
                : `<span class="el-badge el-badge-shared">🟡 SHARED</span>`;
            html += `
            <div class="scanner-element-row" data-idx="${el.idx}" onclick="selectElement(${el.idx})">
                <span class="el-tag" style="color:${meta.color}">&lt;${escapeHTML(el.tag)}&gt;</span>
                <span class="el-preview">${escapeHTML(preview.substring(0, 50))}</span>
                <div class="el-badges">${uniqueBadge}${classBadge}</div>
            </div>`;
        }
        html += `</div></div>`;
    }

    treeEl.innerHTML = html;
}

window.toggleScannerGroup = function (id, btn) {
    const el = document.getElementById(id);
    const open = el.classList.toggle('open');
    btn.classList.toggle('open', open);
};

window.filterElements = function (query) {
    const q = query.toLowerCase();
    document.querySelectorAll('.scanner-element-row').forEach(row => {
        const text = row.textContent.toLowerCase();
        row.style.display = text.includes(q) ? '' : 'none';
    });
};

window.selectElement = async function (idx) {
    if (!scannerData) return;
    const el = scannerData.elements.find(e => e.idx === idx);
    if (!el) return;

    selectedElementIdx = idx;

    // Highlight selected row
    document.querySelectorAll('.scanner-element-row').forEach(r => r.classList.remove('selected'));
    document.querySelector(`.scanner-element-row[data-idx="${idx}"]`)?.classList.add('selected');

    const inspectorContent = document.getElementById('inspectorContent');
    const inspectorEmpty = document.getElementById('inspectorEmptyState');
    inspectorEmpty.style.display = 'none';
    inspectorContent.style.display = '';
    inspectorContent.innerHTML = `<div class="inspector-loading"><span class="scanner-spinner"></span> Generating selector...</div>`;

    try {
        const res = await fetch('/api/generate-selector', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ element: el, url: scannerData.url })
        });
        const data = await res.json();

        if (!res.ok || data.error) {
            inspectorContent.innerHTML = `<div class="scanner-error">⚠️ ${data.error}</div>`;
            return;
        }

        renderInspectorDetail(el, data);
    } catch (err) {
        inspectorContent.innerHTML = `<div class="scanner-error">❌ ${err.message}</div>`;
    }
};

function renderInspectorDetail(el, selectorData) {
    const CATEGORY_COLORS = { button: '#a78bfa', link: '#38bdf8', form: '#34d399', input: '#fbbf24', section: '#f472b6', media: '#fb923c', heading: '#c084fc', other: '#94a3b8' };
    const color = CATEGORY_COLORS[el.category] || '#94a3b8';
    const ic = document.getElementById('inspectorContent');

    const selectorId = 'sel-' + Math.random().toString(36).slice(2, 8);
    const scriptId = 'scr-' + Math.random().toString(36).slice(2, 8);

    // Uniqueness badge — based on actual selector strategy, not just class
    const isUnique = selectorData.selectorType === 'unique' || selectorData.selectorType === 'unique-combo' || selectorData.selectorType === 'unique-parent';
    const uniquenessHtml = isUnique
        ? `<div class="uniqueness-badge unique">🟢 UNIQUE — This selector targets only this element</div>`
        : `<div class="uniqueness-badge shared">🟡 SHARED — Selector may target multiple elements (global tag)</div>`;

    // Class counts table
    let classCountsHtml = '';
    if (el.classUniqueness && Object.keys(el.classUniqueness).length > 0) {
        classCountsHtml = `
        <div class="inspector-section">
            <h5>Class Match Counts</h5>
            <div class="class-counts-table">
                ${Object.entries(el.classUniqueness).map(([cls, count]) => {
                    const isU = count === 1;
                    return `<div class="class-count-row ${isU ? 'unique' : 'shared'}">
                        <span class="class-count-name">.${escapeHTML(cls)}</span>
                        <span class="class-count-badge ${isU ? 'unique' : 'shared'}">${count} match${count !== 1 ? 'es' : ''}</span>
                    </div>`;
                }).join('')}
            </div>
        </div>`;
    }

    ic.innerHTML = `
    <div class="inspector-element-header">
        <span class="inspector-tag" style="color:${color}">&lt;${escapeHTML(el.tag)}&gt;</span>
        <span class="inspector-category-badge" style="background:${color}">${escapeHTML(el.category)}</span>
    </div>
    ${el.text ? `<div class="inspector-text">"${escapeHTML(el.text)}"</div>` : ''}

    ${uniquenessHtml}

    <div class="inspector-section">
        <h5>CSS Selector</h5>
        <div class="selector-output">
            <code id="${selectorId}">${escapeHTML(selectorData.selector)}</code>
            <button class="copy-btn-sm" onclick="copySelectorText('${selectorId}')">📋 Copy</button>
        </div>
        <div class="selector-explain">${escapeHTML(selectorData.selectorExplanation)}</div>
    </div>

    ${classCountsHtml}

    <div class="inspector-section">
        <h5>Tealium Script</h5>
        <div class="code-block-wrapper">
            <div class="code-block-header">
                <span>utag.link()</span>
                <button class="copy-btn" onclick="copyCode('${scriptId}')">Copy</button>
            </div>
            <pre class="code-block" id="${scriptId}">${escapeHTML(selectorData.tealiumScript)}</pre>
        </div>
    </div>
    `;
}

window.copySelectorText = function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    navigator.clipboard.writeText(el.textContent).then(() => {
        const btn = el.closest('.selector-output')?.querySelector('.copy-btn-sm');
        if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy', 2000); }
    });
};

