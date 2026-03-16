const express = require('express');
const cheerio = require('cheerio');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const PORT = process.env.PORT || 3001;
const IS_CLOUD = process.env.RENDER === 'true' || process.env.NODE_ENV === 'production';

// Initialize SQLite DB Connection
const db = new sqlite3.Database(path.join(__dirname, 'chat_history.db'), (err) => {
  if (err) console.error('DB Error:', err.message);
  else {
    db.run("CREATE TABLE IF NOT EXISTS chats (id INTEGER PRIMARY KEY AUTOINCREMENT, user_message TEXT, ai_response TEXT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP)");
  }
});

// Load SDR Variables
let sdrVariables = [];
const sdrPath = path.join(__dirname, 'sdr_variables.json');
if (fs.existsSync(sdrPath)) {
  try {
    const rawData = fs.readFileSync(sdrPath, 'utf8');
    sdrVariables = JSON.parse(rawData);
    console.log(`Loaded ${sdrVariables.length} SDR variables.`);
  } catch (err) {
    console.error('Error loading SDR variables:', err);
  }
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ──────────────────────────────────────────────
   POST /api/chat
   LLM-powered conversational endpoint
   Uses Google Gemini 2.5 Flash (free tier)
   ────────────────────────────────────────────── */
const SDR_CONTEXT = sdrVariables.length > 0
  ? `\n\nOFFICIAL DATA LAYER VARIABLES (FROM SDR):\nYou MUST prioritize using these exact variable names when generating code:\n` +
  sdrVariables.map(v => `- "${v.name}" (${v.description})`).join('\n')
  : '';

const SYSTEM_PROMPT = `You are ASH, an expert AI assistant specializing in:
1. Tealium iQ Tag Management & Universal Data Hub
2. Web analytics implementation (utag.link, utag.view, utag_data)
3. Data layer design and variable naming conventions
4. HTML/CSS/JS code generation for tracked web elements

Your personality: Cool, confident, helpful. Use emojis sparingly. Be concise but thorough.

Key rules:
- When generating Tealium code, ALWAYS use proper utag.link() or utag.view() syntax
- Suggest standard Tealium variable names like: tealium_event, page_name, page_category, event_category, event_action, event_label, etc.
- When the user provides scanned page context, reference SPECIFIC elements by their text, id, or class
- Format code in markdown code blocks with language tags
- For variable suggestions, explain what each variable tracks and recommend naming conventions
- If asked to tag a specific element from a scanned page, generate precise tracking code for that exact element
- Always include both the JavaScript tracking call AND the data layer variable setup

Variable naming best practices you should recommend:
- Use snake_case for all variable names
- Prefix page-level vars with "page_" (page_name, page_category, page_url)
- Prefix event-level vars with "event_" (event_category, event_action, event_label)
- Prefix user-level vars with "user_" (user_id, user_login_status, user_type)
- Prefix product vars with "product_" (product_id, product_name, product_price)
- Prefix form vars with "form_" (form_id, form_name, form_step)
- Use tealium_event as the primary event identifier${SDR_CONTEXT}`;

app.post('/api/chat', async (req, res) => {
  const { message, context, modelName, apiKey } = req.body;

  if (!message) return res.status(400).json({ error: 'message is required' });

  try {
    // Build context-aware prompt
    let contextBlock = '';
    if (context) {
      contextBlock = `\n\n--- SCANNED PAGE CONTEXT ---
URL: ${context.url || 'N/A'}
Page Title: ${context.pageTitle || 'N/A'}
Meta Description: ${context.metaDescription || 'N/A'}

Buttons found (${context.buttons?.length || 0}):\n${(context.buttons || []).map((b, i) =>
        `  ${i + 1}. Text: "${b.text}" | Tag: ${b.tag} | ID: ${b.id || 'none'} | Classes: ${b.classes || 'none'}${b.onclick ? ' | onclick: ' + b.onclick : ''}`
      ).join('\n')}

Forms found (${context.forms?.length || 0}):\n${(context.forms || []).map((f, i) =>
        `  ${i + 1}. ID: ${f.id || 'none'} | Action: ${f.action || 'none'} | Method: ${f.method} | Fields: ${(f.fields || []).map(fd => fd.name || fd.type).join(', ')}`
      ).join('\n')}

Links found (${context.links?.length || 0} total, showing first 15):\n${(context.links || []).slice(0, 15).map((l, i) =>
        `  ${i + 1}. Text: "${l.text}" | Href: ${l.href} | ID: ${l.id || 'none'}`
      ).join('\n')}

PDFs found: ${context.pdfs?.length || 0}
--- END CONTEXT ---`;
    }

    const fullPrompt = `${SYSTEM_PROMPT}${contextBlock}\n\nUser: ${message}`;

    let replyText = '';
    const geminiKey = apiKey || process.env.GEMINI_API_KEY;

    // Try Ollama first (local), fallback to Gemini (cloud)
    try {
      const ollamaRes = await axios.post('http://localhost:11434/api/generate', {
        model: modelName || 'llama3',
        prompt: fullPrompt,
        stream: false
      }, { timeout: 30000 });
      replyText = ollamaRes.data.response;
      console.log('[Chatbot] Response from Ollama');
    } catch (ollamaErr) {
      // Ollama not available, try Gemini
      if (geminiKey) {
        console.log('[Chatbot] Ollama unavailable, using Gemini...');
        const genAI = new GoogleGenerativeAI(geminiKey);
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const result = await model.generateContent(fullPrompt);
        replyText = result.response.text();
      } else {
        throw new Error('AI unavailable. Ollama is not running and no Gemini API key provided.');
      }
    }

    // Log to DB
    db.run("INSERT INTO chats (user_message, ai_response) VALUES (?, ?)", [message, replyText], function(err) {
      if(err) console.error("DB Insert Error:", err.message);
    });

    res.json({ success: true, reply: replyText });

  } catch (err) {
    console.error('Chat API error:', err.message);
    res.status(500).json({ error: 'Failed to get AI response', details: err.message });
  }
});

/* ──────────────────────────────────────────────
   POST /api/analyze
   Fetches a URL and extracts page elements
   ────────────────────────────────────────────── */
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url) return res.status(400).json({ error: 'URL is required' });

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = 'https://' + targetUrl;
  }

  try {
    const { data: html } = await axios.get(targetUrl, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const $ = cheerio.load(html);

    // ── Links ──────────────────────────────
    const links = [];
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().substring(0, 80);
      const id = $(el).attr('id') || '';
      const classes = $(el).attr('class') || '';
      if (href) {
        links.push({ text: text || '[no text]', href, id, classes });
      }
    });

    // ── Buttons ────────────────────────────
    const buttons = [];
    $('button, input[type="button"], input[type="submit"], [role="button"]').each((_, el) => {
      const tag = el.tagName || el.name;
      const text = $(el).text().trim() || $(el).attr('value') || '';
      const type = $(el).attr('type') || '';
      const id = $(el).attr('id') || '';
      const classes = $(el).attr('class') || '';
      const onclick = $(el).attr('onclick') || '';
      const rawHtml = $.html(el).substring(0, 300);
      buttons.push({ tag, text: text.substring(0, 80), type, id, classes, onclick: onclick.substring(0, 120), rawHtml });
    });

    // ── Forms ──────────────────────────────
    const forms = [];
    $('form').each((_, el) => {
      const action = $(el).attr('action') || '';
      const method = $(el).attr('method') || 'GET';
      const id = $(el).attr('id') || '';
      const fields = [];
      $(el).find('input, select, textarea').each((__, field) => {
        fields.push({
          tag: field.tagName || field.name,
          name: $(field).attr('name') || '',
          type: $(field).attr('type') || '',
          id: $(field).attr('id') || '',
          placeholder: $(field).attr('placeholder') || ''
        });
      });
      const rawHtml = $.html(el).substring(0, 500);
      forms.push({ action, method: method.toUpperCase(), id, fields, rawHtml });
    });

    // ── PDFs ───────────────────────────────
    const pdfs = [];
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/\.pdf(\?.*)?$/i.test(href)) {
        const text = $(el).text().trim().substring(0, 80);
        pdfs.push({ text: text || '[PDF link]', href });
      }
    });

    // ── Page meta ──────────────────────────
    const pageTitle = $('title').text().trim();
    const metaDesc = $('meta[name="description"]').attr('content') || '';

    res.json({
      success: true,
      url: targetUrl,
      pageTitle,
      metaDescription: metaDesc,
      summary: {
        totalLinks: links.length,
        totalButtons: buttons.length,
        totalForms: forms.length,
        totalPDFs: pdfs.length
      },
      links: links.slice(0, 50),
      buttons: buttons.slice(0, 30),
      forms: forms.slice(0, 10),
      pdfs: pdfs.slice(0, 20)
    });

  } catch (err) {
    res.status(500).json({
      error: 'Failed to analyze URL',
      details: err.message
    });
  }
});

/* ──────────────────────────────────────────────
   POST /api/suggest
   Returns HTML/CSS snippet + Tealium script
   for a requested element type
   ────────────────────────────────────────────── */
app.post('/api/suggest', (req, res) => {
  const { elementType, options = {} } = req.body;

  if (!elementType) return res.status(400).json({ error: 'elementType is required' });

  const type = elementType.toLowerCase();
  const result = generateElementSuggestion(type, options);

  res.json({ success: true, ...result });
});

/* ──────────────────────────────────────────────
   POST /api/tealium
   Returns a Tealium tracking script for
   a given element / interaction
   ────────────────────────────────────────────── */
app.post('/api/tealium', (req, res) => {
  const { eventType, elementDetails = {} } = req.body;

  if (!eventType) return res.status(400).json({ error: 'eventType is required' });

  const script = generateTealiumScript(eventType, elementDetails);
  res.json({ success: true, ...script });
});

/* ═══════════════════════════════════════════════
   Helper: Generate Element Suggestions
   ═══════════════════════════════════════════════ */
function generateElementSuggestion(type, opts) {
  const suggestions = {
    button: {
      html: `<button
  id="${opts.id || 'cta-button'}"
  class="${opts.classes || 'btn btn-primary'}"
  data-tealium-event="button_click"
  data-tealium-category="${opts.category || 'engagement'}"
  onclick="trackButtonClick(this)"
>
  ${opts.text || 'Click Me'}
</button>`,
      css: `.btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 12px 28px;
  border: none;
  border-radius: 8px;
  font-size: 16px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}
.btn-primary {
  background: linear-gradient(135deg, #6366f1, #8b5cf6);
  color: #fff;
  box-shadow: 0 4px 15px rgba(99,102,241,0.4);
}
.btn-primary:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(99,102,241,0.6);
}`,
      tealiumVariables: {
        tealium_event: 'button_click',
        event_category: opts.category || 'engagement',
        event_action: 'click',
        event_label: opts.text || 'Click Me',
        button_id: opts.id || 'cta-button',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'button_click',
        event_category: opts.category || 'engagement',
        event_action: 'click',
        event_label: opts.text || 'Click Me',
        button_id: opts.id || 'cta-button'
      })
    },

    link: {
      html: `<a
  id="${opts.id || 'nav-link'}"
  href="${opts.href || '#'}"
  class="${opts.classes || 'tracked-link'}"
  data-tealium-event="link_click"
  data-tealium-category="${opts.category || 'navigation'}"
  onclick="trackLinkClick(this)"
>
  ${opts.text || 'Learn More'}
</a>`,
      css: `.tracked-link {
  color: #6366f1;
  text-decoration: none;
  font-weight: 500;
  position: relative;
  transition: color 0.3s ease;
}
.tracked-link::after {
  content: '';
  position: absolute;
  bottom: -2px; left: 0;
  width: 0; height: 2px;
  background: #8b5cf6;
  transition: width 0.3s ease;
}
.tracked-link:hover { color: #8b5cf6; }
.tracked-link:hover::after { width: 100%; }`,
      tealiumVariables: {
        tealium_event: 'link_click',
        event_category: opts.category || 'navigation',
        event_action: 'click',
        event_label: opts.text || 'Learn More',
        link_id: opts.id || 'nav-link',
        link_url: opts.href || '#',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'link_click',
        event_category: opts.category || 'navigation',
        event_action: 'click',
        event_label: opts.text || 'Learn More',
        link_id: opts.id || 'nav-link',
        link_url: opts.href || '#'
      })
    },

    form: {
      html: `<form
  id="${opts.id || 'contact-form'}"
  class="${opts.classes || 'tracked-form'}"
  action="${opts.action || '#'}"
  method="${opts.method || 'POST'}"
  data-tealium-event="form_submit"
  onsubmit="trackFormSubmit(event, this)"
>
  <div class="form-group">
    <label for="name">Name</label>
    <input type="text" id="name" name="name" placeholder="Your name" required />
  </div>
  <div class="form-group">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" placeholder="you@example.com" required />
  </div>
  <div class="form-group">
    <label for="message">Message</label>
    <textarea id="message" name="message" rows="4" placeholder="Your message"></textarea>
  </div>
  <button type="submit" class="btn btn-primary">Submit</button>
</form>`,
      css: `.tracked-form {
  max-width: 480px;
  padding: 32px;
  background: rgba(255,255,255,0.05);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 16px;
  backdrop-filter: blur(10px);
}
.form-group {
  margin-bottom: 20px;
}
.form-group label {
  display: block;
  margin-bottom: 6px;
  font-weight: 500;
  color: #cbd5e1;
}
.form-group input,
.form-group textarea {
  width: 100%;
  padding: 10px 14px;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  border-radius: 8px;
  color: #f1f5f9;
  font-size: 14px;
  transition: border-color 0.3s;
}
.form-group input:focus,
.form-group textarea:focus {
  outline: none;
  border-color: #6366f1;
}`,
      tealiumVariables: {
        tealium_event: 'form_submit',
        event_category: opts.category || 'conversion',
        event_action: 'submit',
        form_id: opts.id || 'contact-form',
        form_name: opts.formName || 'Contact Form',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'form_submit',
        event_category: opts.category || 'conversion',
        event_action: 'submit',
        form_id: opts.id || 'contact-form',
        form_name: opts.formName || 'Contact Form'
      })
    },

    pdf: {
      html: `<a
  id="${opts.id || 'pdf-download'}"
  href="${opts.href || '/docs/document.pdf'}"
  class="${opts.classes || 'pdf-link'}"
  target="_blank"
  data-tealium-event="pdf_download"
  onclick="trackPDFDownload(this)"
>
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
    <polyline points="14 2 14 8 20 8"/>
    <line x1="16" y1="13" x2="8" y2="13"/>
    <line x1="16" y1="17" x2="8" y2="17"/>
    <polyline points="10 9 9 9 8 9"/>
  </svg>
  ${opts.text || 'Download PDF'}
</a>`,
      css: `.pdf-link {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: rgba(239,68,68,0.15);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: 8px;
  color: #f87171;
  text-decoration: none;
  font-weight: 500;
  transition: all 0.3s;
}
.pdf-link:hover {
  background: rgba(239,68,68,0.25);
  transform: translateY(-1px);
}`,
      tealiumVariables: {
        tealium_event: 'pdf_download',
        event_category: 'download',
        event_action: 'click',
        event_label: opts.text || 'Download PDF',
        file_name: opts.href || '/docs/document.pdf',
        file_type: 'pdf',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'pdf_download',
        event_category: 'download',
        event_action: 'click',
        event_label: opts.text || 'Download PDF',
        file_name: opts.href || '/docs/document.pdf',
        file_type: 'pdf'
      })
    },

    image: {
      html: `<figure
  id="${opts.id || 'hero-image'}"
  class="${opts.classes || 'tracked-image'}"
  data-tealium-event="image_view"
>
  <img
    src="${opts.src || 'https://via.placeholder.com/600x400'}"
    alt="${opts.alt || 'Hero image'}"
    loading="lazy"
    onclick="trackImageClick(this)"
  />
  <figcaption>${opts.caption || 'Image caption'}</figcaption>
</figure>`,
      css: `.tracked-image {
  margin: 0;
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 30px rgba(0,0,0,0.3);
  transition: transform 0.3s;
}
.tracked-image:hover { transform: scale(1.02); }
.tracked-image img {
  width: 100%;
  display: block;
  cursor: pointer;
}
.tracked-image figcaption {
  padding: 12px 16px;
  background: rgba(0,0,0,0.6);
  color: #cbd5e1;
  font-size: 14px;
}`,
      tealiumVariables: {
        tealium_event: 'image_click',
        event_category: 'engagement',
        event_action: 'click',
        image_id: opts.id || 'hero-image',
        image_alt: opts.alt || 'Hero image',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'image_click',
        event_category: 'engagement',
        event_action: 'click',
        image_id: opts.id || 'hero-image',
        image_alt: opts.alt || 'Hero image'
      })
    },

    video: {
      html: `<div
  id="${opts.id || 'video-player'}"
  class="${opts.classes || 'tracked-video'}"
  data-tealium-event="video_play"
>
  <video
    controls
    poster="${opts.poster || ''}"
    onplay="trackVideoPlay(this)"
    onpause="trackVideoPause(this)"
    onended="trackVideoEnd(this)"
  >
    <source src="${opts.src || 'video.mp4'}" type="video/mp4" />
    Your browser does not support the video tag.
  </video>
</div>`,
      css: `.tracked-video {
  border-radius: 12px;
  overflow: hidden;
  box-shadow: 0 8px 30px rgba(0,0,0,0.3);
}
.tracked-video video {
  width: 100%;
  display: block;
}`,
      tealiumVariables: {
        tealium_event: 'video_play',
        event_category: 'media',
        event_action: 'play',
        video_id: opts.id || 'video-player',
        video_title: opts.title || 'Video',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'video_play',
        event_category: 'media',
        event_action: 'play',
        video_id: opts.id || 'video-player',
        video_title: opts.title || 'Video'
      })
    },

    navbar: {
      html: `<nav id="${opts.id || 'main-nav'}" class="${opts.classes || 'tracked-navbar'}">
  <div class="nav-brand">${opts.brand || 'Brand'}</div>
  <ul class="nav-links">
    <li><a href="#home" data-tealium-event="nav_click" onclick="trackNavClick(this)">Home</a></li>
    <li><a href="#about" data-tealium-event="nav_click" onclick="trackNavClick(this)">About</a></li>
    <li><a href="#services" data-tealium-event="nav_click" onclick="trackNavClick(this)">Services</a></li>
    <li><a href="#contact" data-tealium-event="nav_click" onclick="trackNavClick(this)">Contact</a></li>
  </ul>
</nav>`,
      css: `.tracked-navbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 32px;
  background: rgba(15,23,42,0.9);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255,255,255,0.1);
  position: sticky;
  top: 0;
  z-index: 100;
}
.nav-brand {
  font-size: 20px;
  font-weight: 700;
  color: #f1f5f9;
}
.nav-links {
  display: flex;
  list-style: none;
  gap: 24px;
  margin: 0; padding: 0;
}
.nav-links a {
  color: #94a3b8;
  text-decoration: none;
  font-weight: 500;
  transition: color 0.3s;
}
.nav-links a:hover { color: #6366f1; }`,
      tealiumVariables: {
        tealium_event: 'nav_click',
        event_category: 'navigation',
        event_action: 'click',
        nav_item: '{{link_text}}',
        nav_url: '{{link_href}}',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: 'nav_click',
        event_category: 'navigation',
        event_action: 'click',
        nav_item: '{{link_text}}',
        nav_url: '{{link_href}}'
      })
    }
  };

  const suggestion = suggestions[type];

  if (!suggestion) {
    // Fallback: generic element
    return {
      elementType: type,
      html: `<div id="${opts.id || 'custom-element'}" class="${opts.classes || 'custom-el'}" data-tealium-event="${type}_interaction">\n  <!-- Your ${type} content here -->\n</div>`,
      css: `/* Add your styles for .custom-el here */\n.custom-el {\n  padding: 16px;\n  border-radius: 8px;\n}`,
      tealiumVariables: {
        tealium_event: `${type}_interaction`,
        event_category: opts.category || 'engagement',
        event_action: 'interact',
        element_id: opts.id || 'custom-element',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      },
      tealiumScript: generateTealiumTrackingCode('link', {
        tealium_event: `${type}_interaction`,
        event_category: opts.category || 'engagement',
        event_action: 'interact',
        element_id: opts.id || 'custom-element'
      })
    };
  }

  return { elementType: type, ...suggestion };
}

/* ═══════════════════════════════════════════════
   Helper: Generate Tealium Tracking Code
   ═══════════════════════════════════════════════ */
function generateTealiumTrackingCode(callType, dataLayer) {
  const fnName = callType === 'view' ? 'utag.view' : 'utag.link';
  const lines = Object.entries(dataLayer)
    .map(([k, v]) => `    "${k}": "${v}"`)
    .join(',\n');

  return `// Tealium Universal Tag – ${callType} tracking
${fnName}({
${lines}
});`;
}

function generateTealiumScript(eventType, details) {
  const type = eventType.toLowerCase();

  const eventMap = {
    page_view: {
      callType: 'view',
      vars: {
        tealium_event: 'page_view',
        page_name: details.pageName || '{{page_name}}',
        page_url: details.pageUrl || '{{page_url}}',
        page_category: details.category || '{{page_category}}',
        page_subcategory: details.subcategory || '',
        site_section: details.section || '',
        user_login_status: '{{logged_in|logged_out}}',
        page_language: details.language || 'en'
      }
    },
    click: {
      callType: 'link',
      vars: {
        tealium_event: 'element_click',
        event_category: details.category || 'engagement',
        event_action: 'click',
        event_label: details.label || '{{element_text}}',
        element_id: details.elementId || '{{element_id}}',
        element_type: details.elementType || '{{element_type}}',
        page_name: '{{page_name}}'
      }
    },
    form_submit: {
      callType: 'link',
      vars: {
        tealium_event: 'form_submit',
        event_category: 'conversion',
        event_action: 'submit',
        form_id: details.formId || '{{form_id}}',
        form_name: details.formName || '{{form_name}}',
        form_step: details.step || '1',
        page_name: '{{page_name}}'
      }
    },
    download: {
      callType: 'link',
      vars: {
        tealium_event: 'file_download',
        event_category: 'download',
        event_action: 'click',
        file_name: details.fileName || '{{file_name}}',
        file_type: details.fileType || 'pdf',
        file_url: details.fileUrl || '{{file_url}}',
        page_name: '{{page_name}}'
      }
    },
    video: {
      callType: 'link',
      vars: {
        tealium_event: `video_${details.action || 'play'}`,
        event_category: 'media',
        event_action: details.action || 'play',
        video_id: details.videoId || '{{video_id}}',
        video_title: details.videoTitle || '{{video_title}}',
        video_duration: details.duration || '{{video_duration}}',
        video_percent: details.percent || '0',
        page_name: '{{page_name}}'
      }
    },
    ecommerce: {
      callType: 'link',
      vars: {
        tealium_event: details.action || 'product_view',
        event_category: 'ecommerce',
        event_action: details.action || 'product_view',
        product_id: details.productId || '{{product_id}}',
        product_name: details.productName || '{{product_name}}',
        product_price: details.price || '{{product_price}}',
        product_category: details.category || '{{product_category}}',
        currency_code: details.currency || 'USD',
        page_name: '{{page_name}}'
      }
    },
    scroll: {
      callType: 'link',
      vars: {
        tealium_event: 'scroll_depth',
        event_category: 'engagement',
        event_action: 'scroll',
        scroll_depth: details.depth || '{{scroll_percent}}',
        page_name: '{{page_name}}',
        page_url: '{{page_url}}'
      }
    }
  };

  const config = eventMap[type] || eventMap['click'];

  const utagDataLines = Object.entries(config.vars)
    .map(([k, v]) => `  "${k}": "${v}"`)
    .join(',\n');

  const script = generateTealiumTrackingCode(config.callType, config.vars);

  const utagDataObj = `// Set utag_data before the call (or include in the data layer)\nvar utag_data = utag_data || {};\n${Object.entries(config.vars).map(([k, v]) => `utag_data["${k}"] = "${v}";`).join('\n')}`;

  return {
    eventType: type,
    callType: config.callType,
    variables: config.vars,
    utagDataSetup: utagDataObj,
    trackingScript: script,
    fullSnippet: `<!-- Tealium Universal Tag Snippet -->\n<script type="text/javascript">\n${script}\n</script>`
  };
}

/* ══════════════════════════════════════════════════
   PHASE 1 — TAG SCANNER: Deep Element Scan
   Uses Puppeteer (headless Chrome) to render
   the page with JS — so classes & selectors match
   exactly what you see in Chrome DevTools.
   Now includes class uniqueness checking via
   document.querySelectorAll('.class').length
   ══════════════════════════════════════════════════ */
app.post('/api/scan-elements', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  let targetUrl = url.trim();
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  let browser;
  try {
    console.log(`[Scanner] Launching headless browser for: ${targetUrl}`);
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    
    // Auto-scroll down the page to trigger lazy-loaded elements
    console.log(`[Scanner] Auto-scrolling to trigger lazy loading...`);
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        let distance = 300;
        let timer = setInterval(() => {
          let scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if(totalHeight >= scrollHeight - window.innerHeight){
            clearInterval(timer);
            window.scrollTo(0, 0); // Scroll back up
            resolve();
          }
        }, 150);
      });
    });
    
    // Extra wait for any final renders after scrolling
    await new Promise(resolve => setTimeout(resolve, 3000));

    console.log(`[Scanner] Page loaded and scrolled, extracting elements from rendered DOM...`);

    // Extract elements + class uniqueness from the RENDERED DOM
    const result = await page.evaluate(() => {
      // Expanded selectors to catch generic elements acting as interactive items
      const SELECTORS = 'a, button, input, select, textarea, form, [role="button"], [onclick], nav, header, footer, img, video, iframe, [data-tealium], [data-analytics], h1, h2, h3, li.dropdown, .dropdown-toggle, [aria-controls], [aria-expanded], [class*="btn"], [class*="cta"], [class*="teaser"], [class*="link"], [class*="item"], [class*="icon"]';

      const allEls = document.querySelectorAll(SELECTORS);
      const elements = [];
      let idx = 0;

      // Cache class counts to avoid repeated querySelectorAll
      const classCountCache = {};
      function getClassCount(className) {
        if (classCountCache[className] === undefined) {
          classCountCache[className] = document.querySelectorAll('.' + CSS.escape(className)).length;
        }
        return classCountCache[className];
      }

      allEls.forEach((el) => {
        const tagName = el.tagName.toLowerCase();

        // Get all attributes (skip id)
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }

        // Text content from rendered DOM
        let textContent = '';
        for (const node of el.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) {
            textContent += node.textContent.trim() + ' ';
          }
        }
        textContent = textContent.trim();
        if (!textContent) textContent = el.textContent?.trim() || '';
        textContent = textContent.replace(/\s+/g, ' ').substring(0, 100);

        // Parent info — walk up to 6 levels (like a dev in DevTools)
        const parentChain = [];
        let parent = el.parentElement;
        for (let i = 0; i < 6 && parent && parent !== document.body; i++) {
          const pClasses = (typeof parent.className === 'string') ? parent.className : '';
          parentChain.push({
            tag: parent.tagName.toLowerCase(),
            classes: pClasses
          });
          parent = parent.parentElement;
        }

        // Sibling index
        let siblingIndex = 0;
        let siblingCount = 0;
        if (el.parentElement) {
          const siblings = el.parentElement.querySelectorAll(':scope > ' + tagName);
          siblingCount = siblings.length;
          siblings.forEach((sib, si) => {
            if (sib === el) siblingIndex = si;
          });
        }

        // ═══════════════════════════════════════════════════
        // CLASS UNIQUENESS — thinking like a Tealium developer
        // Step 1: Check each individual class
        // Step 2: Try class combos on the element itself
        // Step 3: Walk UP the DOM — try parent + child class
        //         e.g. ".fme-teaser--start-game .cmp-teaser__action-link"
        //         verified via querySelectorAll().length === 1
        // ═══════════════════════════════════════════════════
        // Transient/State Class Filtering
        // Filter out classes that reflect temporary UI state 
        // to ensure generated selectors are stable.
        const transientClasses = ['active', 'hover', 'focus', 'open', 'disabled', 'is-active', 'is-open', 'is-hovered', 'is-focused', 'selected', 'is-selected', 'hidden', 'is-hidden', 'visible', 'is-visible', 'show', 'hide'];
        
        const classes = (attrs.class || '').trim();
        const classList = classes ? classes.split(/\s+/).filter(c => c.length > 0 && !transientClasses.includes(c.toLowerCase())) : [];
        const classUniqueness = {};
        let hasUniqueClass = false;
        let uniqueClassName = '';
        let uniqueClassCombo = '';
        let uniqueParentChildSelector = '';  // e.g. ".fme-teaser--start-game .cmp-teaser__action-link"

        // Step 1: Check individual classes
        for (const cls of classList) {
          const count = getClassCount(cls);
          classUniqueness[cls] = count;
          if (count === 1 && !hasUniqueClass) {
            hasUniqueClass = true;
            uniqueClassName = cls;
          }
        }

        // Step 2: Try class combos on the element
        if (!hasUniqueClass && classList.length >= 2) {
          const fullComboSelector = classList.map(c => '.' + CSS.escape(c)).join('');
          const fullComboCount = document.querySelectorAll(fullComboSelector).length;
          if (fullComboCount === 1) {
            hasUniqueClass = true;
            uniqueClassCombo = classList.join('.');
            classUniqueness['[COMBO] ' + classList.join('.')] = 1;
          } else {
            const sorted = [...classList].sort((a, b) =>
              (classUniqueness[a] || 999) - (classUniqueness[b] || 999)
            );
            for (let i = 0; i < sorted.length && !hasUniqueClass; i++) {
              for (let j = i + 1; j < sorted.length && !hasUniqueClass; j++) {
                const pairSelector = '.' + CSS.escape(sorted[i]) + '.' + CSS.escape(sorted[j]);
                const pairCount = document.querySelectorAll(pairSelector).length;
                if (pairCount === 1) {
                  hasUniqueClass = true;
                  uniqueClassCombo = sorted[i] + '.' + sorted[j];
                  classUniqueness['[COMBO] ' + sorted[i] + '.' + sorted[j]] = 1;
                }
              }
            }
          }
        }

        // Step 3: PARENT-CHILD selector — the Tealium dev approach
        // Walk up the DOM tree, for each parent class, check:
        //   document.querySelectorAll('.parentClass .childClass').length === 1
        if (!hasUniqueClass && classList.length > 0) {
          let foundParentChild = false;
          let p = el.parentElement;
          for (let depth = 0; depth < 6 && p && p !== document.body && !foundParentChild; depth++) {
            const pClassStr = (typeof p.className === 'string') ? p.className : '';
            const pClasses = pClassStr.trim().split(/\s+/).filter(c => c.length > 0);
            for (const pCls of pClasses) {
              // Try each element class with this parent class
              for (const eCls of classList) {
                const testSelector = '.' + CSS.escape(pCls) + ' .' + CSS.escape(eCls);
                try {
                  const testCount = document.querySelectorAll(testSelector).length;
                  if (testCount === 1) {
                    foundParentChild = true;
                    hasUniqueClass = true;
                    uniqueParentChildSelector = '.' + pCls + ' .' + eCls;
                    classUniqueness['[PARENT] .' + pCls + ' .' + eCls] = 1;
                    break;
                  }
                } catch (e) { /* skip invalid selectors */ }
              }
              if (foundParentChild) break;
            }
            p = p.parentElement;
          }
        }

        // Category
        let category = 'other';
        if (tagName === 'a') category = 'link';
        else if (tagName === 'button' || attrs.role === 'button') category = 'button';
        else if (['input', 'select', 'textarea'].includes(tagName)) category = 'input';
        else if (tagName === 'form') category = 'form';
        else if (['nav', 'header', 'footer'].includes(tagName)) category = 'section';
        else if (['img', 'video', 'iframe'].includes(tagName)) category = 'media';
        else if (['h1', 'h2', 'h3'].includes(tagName)) category = 'heading';
        if (tagName === 'input' && ['button', 'submit', 'reset'].includes(attrs.type)) category = 'button';

        // Data attributes
        const dataAttrs = {};
        for (const [k, v] of Object.entries(attrs)) {
          if (k.startsWith('data-')) dataAttrs[k] = v;
        }

        elements.push({
          idx: idx++,
          tag: tagName,
          category,
          text: textContent || attrs.value?.substring(0, 60) || attrs.alt?.substring(0, 60) || attrs.placeholder?.substring(0, 60) || '',
          classes,
          type: attrs.type || '',
          href: attrs.href || '',
          name: attrs.name || '',
          ariaLabel: attrs['aria-label'] || '',
          dataAttrs,
          parentChain,
          siblingIndex,
          siblingCount,
          classUniqueness,
          hasUniqueClass,
          uniqueClassName,
          uniqueClassCombo,
          uniqueParentChildSelector,
          allAttrs: attrs
        });
      });

      const pageTitle = document.title || '';
      const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

      return { elements, pageTitle, metaDescription: metaDesc };
    });

    // Summary counts
    const counts = {};
    for (const el of result.elements) {
      counts[el.category] = (counts[el.category] || 0) + 1;
    }

    console.log(`[Scanner] Found ${result.elements.length} elements (rendered DOM)`);

    res.json({
      success: true,
      url: targetUrl,
      pageTitle: result.pageTitle,
      metaDescription: result.metaDescription,
      totalElements: result.elements.length,
      counts,
      elements: result.elements
    });

  } catch (err) {
    console.error('[Scanner] Error:', err.message);
    res.status(500).json({ error: 'Failed to scan URL', details: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

/* ══════════════════════════════════════════════════
   TAG SCANNER: Generate Unique Selector
   Adobe SDR Event Types:
     event3 = Generic Link Click (all links except PDFs)
     event1 = PDF Download (.pdf, .xlsx, .tif)
   NO exit_link event exists in the SDR.
   ══════════════════════════════════════════════════ */
app.post('/api/generate-selector', (req, res) => {
  const { element, url } = req.body;
  if (!element) return res.status(400).json({ error: 'element data is required' });

  const selector = buildUniqueSelector(element);
  const tealiumVars = buildTealiumVarsForElement(element);

  // ── Determine link type from Adobe SDR ──
  const elementText = (element.text || 'click').trim().replace(/['\"\`>]/g, '');
  const hrefStr = (element.href || '').toLowerCase();
  const isPdfOrDoc = /\.(pdf|xlsx|tif)(\?|$)/i.test(hrefStr);

  let tealiumScript = '';

  if (isPdfOrDoc) {
    // ══ PDF Download (event 1) ══
    // SDR evars: evar23=Download Name, evar26=Link Text,
    //            evar27=Link Location, evar35=Link href, evar36=Download Type
    let fileExt = 'pdf';
    if (/\.xlsx/i.test(hrefStr)) fileExt = 'xlsx';
    if (/\.tif/i.test(hrefStr)) fileExt = 'tif';

    tealiumScript = `//${elementText}-download
try { document.querySelectorAll("a[href*='.${fileExt}'],a[href*='.${fileExt.toUpperCase()}']").forEach(function(item){ item.addEventListener('mousedown', function(){ var downloadName = decodeURIComponent(this.href.split('/documents/').pop().split('.${fileExt}')[0].split('/').pop().replace(/-|\\/|_/g, ' ').replace(/\\s+/g,' ')); var location = item.closest('.cmp-experiencefragment--header') ? 'header' : item.closest('.cmp-experiencefragment--footer') ? 'footer' : 'body';
        utag.link({
            "link_text"     : downloadName || '',
            "link_location" : location,
            "link_click"    : '1',
            "link_href"     : this.href || '',
            "tealium_event" : 'pdf_download',
            "evar23"        : downloadName || '',
            "evar26"        : downloadName || '',
            "evar27"        : location,
            "evar35"        : this.href || '',
            "evar36"        : '${fileExt}'
        });
    }); }); } catch(e) {}`;

  } else {
    // ══ Generic Link Click (event 3) ══
    // SDR evars: evar26=Link Text, evar27=Link Location, evar35=Link href
    tealiumScript = `//${elementText}
document.addEventListener('mousedown', function(event){
    var target = event.target;
    var item = target.closest('${selector}');
    if(item){
     var linkHref = item.closest('${selector}')?.href;
     var linkText = item.closest('${selector}')?.textContent?.trim().toLowerCase();
        console.log('link text2-->' + linkText);
        var location = target.closest('.cmp-experiencefragment--header') ? 'header' : target.closest('.cmp-experiencefragment--footer') ? 'footer' : 'body';
        utag.link({
           "link_text"     : linkText || '',
            "link_location": location,
            "link_click"    : '1',
            "link_href"     : linkHref || '',
            "tealium_event" : 'generic_link_click',
            "evar26"        : linkText || '',
            "evar27"        : location,
            "evar35"        : linkHref || ''
            });
    }
});`;
  }

  // Determine actual uniqueness of the chosen selector
  const selectorType = determineSelectorType(selector, element);

  res.json({
    success: true,
    selector,
    selectorType,
    selectorExplanation: explainSelector(selector, element),
    tealiumVariables: tealiumVars,
    tealiumScript
  });
});

/**
 * Build the best CSS selector — thinking like a Tealium developer.
 * NO IDs (they change dynamically).
 * Priority:
 *   1. Single UNIQUE class (querySelectorAll('.class').length === 1)
 *   2. UNIQUE class COMBINATION (.class1.class2 where combo count = 1)
 *   3. data-* attributes
 *   4. aria-label
 *   5. name attribute
 *   6. Shared class with parent context (global tagging)
 *   7. href for links
 *   8. Fallback: parent + nth-child
 */
function buildUniqueSelector(el) {
  const tag = el.tag || 'div';

  // 1. If element has a UNIQUE single class (count=1 on page)
  if (el.hasUniqueClass && el.uniqueClassName) {
    return `.${CSS_escape(el.uniqueClassName)}`;
  }

  // 2. If element has a UNIQUE class COMBINATION on itself
  if (el.hasUniqueClass && el.uniqueClassCombo) {
    const comboClasses = el.uniqueClassCombo.split('.');
    return comboClasses.map(c => `.${CSS_escape(c)}`).join('');
  }

  // 3. PARENT-CHILD selector (the Tealium dev approach)
  //    e.g. ".fme-teaser--start-game .cmp-teaser__action-link" = 1 match
  if (el.hasUniqueClass && el.uniqueParentChildSelector) {
    // Parse the stored selector and CSS-escape the class names
    const parts = el.uniqueParentChildSelector.split(' ');
    return parts.map(part => {
      // Each part is like ".className"
      const cls = part.startsWith('.') ? part.substring(1) : part;
      return `.${CSS_escape(cls)}`;
    }).join(' ');
  }

  // 4. If element has unique data attributes
  const dataAttrs = el.dataAttrs || {};
  for (const [k, v] of Object.entries(dataAttrs)) {
    if (v) return `${tag}[${k}="${v}"]`;
    return `${tag}[${k}]`;
  }

  // 5. aria-label
  if (el.ariaLabel) {
    return `${tag}[aria-label="${el.ariaLabel}"]`;
  }

  // 6. name attribute
  if (el.name) {
    return `${tag}[name="${el.name}"]`;
  }

  // 7. Shared class with parent context (GLOBAL tagging)
  if (el.classes) {
    const classList = el.classes.trim().split(/\s+/).filter(c => c.length > 0);
    if (classList.length > 0) {
      const parentPart = buildParentPrefix(el);
      const sortedClasses = [...classList].sort((a, b) =>
        (el.classUniqueness?.[a] || 999) - (el.classUniqueness?.[b] || 999)
      );
      const bestClass = sortedClasses[0];
      const classSel = `.${CSS_escape(bestClass)}`;
      if (el.siblingCount <= 1) {
        return `${parentPart}${tag}${classSel}`;
      }
      return `${parentPart}${tag}${classSel}:nth-child(${el.siblingIndex + 1})`;
    }
  }

  // 8. href for links
  if (el.href && tag === 'a') {
    const shortHref = el.href.length > 60 ? el.href.substring(0, 60) : el.href;
    return `a[href="${shortHref}"]`;
  }

  // 9. Fallback: parent + nth-child
  const parentPart = buildParentPrefix(el);
  return `${parentPart}${tag}:nth-child(${el.siblingIndex + 1})`;
}

function buildParentPrefix(el) {
  if (!el.parentChain || el.parentChain.length === 0) return '';
  const parent = el.parentChain[0];
  if (parent.classes) {
    const firstClass = parent.classes.trim().split(/\s+/)[0];
    return `${parent.tag}.${CSS_escape(firstClass)} > `;
  }
  return `${parent.tag} > `;
}

function CSS_escape(str) {
  return str.replace(/([^\w-])/g, '\\$1');
}

function determineSelectorType(selector, el) {
  if (el.hasUniqueClass && el.uniqueClassName) return 'unique';
  if (el.hasUniqueClass && el.uniqueClassCombo) return 'unique-combo';
  if (el.hasUniqueClass && el.uniqueParentChildSelector) return 'unique-parent';
  if (selector.includes('[data-')) return 'unique';
  if (selector.includes('[aria-label')) return 'unique';
  if (selector.includes('[name=')) return 'unique';
  return 'global';
}

function explainSelector(selector, el) {
  if (el.hasUniqueClass && el.uniqueClassName) {
    return `Class ".${el.uniqueClassName}" is UNIQUE on this page (1 match) — best for individual tagging.`;
  }
  if (el.hasUniqueClass && el.uniqueClassCombo) {
    return `Class combo ".${el.uniqueClassCombo}" is UNIQUE (1 match) — verified via querySelectorAll.`;
  }
  if (el.hasUniqueClass && el.uniqueParentChildSelector) {
    return `Parent-child selector "${el.uniqueParentChildSelector}" is UNIQUE (1 match) — like a Tealium dev would pick in DevTools.`;
  }
  if (selector.includes('[data-')) return `Using data attribute — unique marker on the element.`;
  if (selector.includes('[aria-label')) return `Using aria-label — typically unique and accessible.`;
  if (selector.includes('[name=')) return `Using name attribute — usually unique within forms.`;
  if (selector.includes('[href=')) return `Using href — identifies this specific link.`;
  if (selector.includes('.')) {
    const classes = el.classUniqueness || {};
    const counts = Object.entries(classes)
      .filter(([c]) => !c.startsWith('[COMBO]'))
      .map(([c, n]) => `".${c}" = ${n} matches`).join(', ');
    return `Shared class (global) — no unique class or combo found. Class counts: ${counts}`;
  }
  return `Positional selector — may break if page structure changes.`;
}

function buildTealiumVarsForElement(el) {
  const category = el.category || 'other';
  const eventMap = {
    button: 'button_click', link: 'link_click', form: 'form_submit',
    input: 'form_field_interaction', media: 'media_interaction',
    section: 'section_interaction', heading: 'content_view', other: 'element_interaction'
  };

  const vars = {
    tealium_event: eventMap[category] || 'element_interaction',
    event_category: category === 'button' ? 'engagement' : category === 'link' ? 'navigation' : category === 'form' ? 'conversion' : 'engagement',
    event_action: category === 'form' ? 'submit' : 'click',
    event_label: el.text || el.classes?.split(' ')[0] || el.tag
  };

  if (el.classes) vars.element_class = el.classes.split(' ')[0];
  if (el.href) vars.link_url = el.href;
  vars.page_name = '{{page_name}}';
  vars.page_url = '{{page_url}}';

  return vars;
}

/* ──────────────────────────────────────────────
   Start server
   ────────────────────────────────────────────── */
app.listen(PORT, () => {
  console.log(`\n  🤖 Chatbot AI running at http://localhost:${PORT}\n`);
});
