/**
 * Dispatch Fill: click the toolbar icon on any application form page and it
 * fills profile fields, uploads the resume, and pastes the drafted message
 * for that job (matched by URL against the Dispatch database). Never submits.
 */

const BASE = "http://localhost:4310";

const MAX_WIZARD_STEPS = 8;

chrome.action.onClicked.addListener(async (tab) => {
  const target = { tabId: tab.id };
  try {
    const res = await fetch(`${BASE}/api/fill-data?url=${encodeURIComponent(tab.url || "")}`);
    if (!res.ok) throw new Error(`Dispatch server responded ${res.status}`);
    const data = await res.json();

    const pdf = await fetch(`${BASE}/api/resume`);
    if (pdf.ok) {
      const buf = new Uint8Array(await pdf.arrayBuffer());
      let bin = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < buf.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
      }
      data.resumeB64 = btoa(bin);
    }

    // Multi-step wizards (Workday etc.): fill the visible step, advance, repeat.
    // Never clicks Submit/Apply — only Next/Continue-style buttons.
    const userStopped = async () =>
      (await chrome.scripting.executeScript({ target, func: () => globalThis.__dispatchStop === true }))[0].result;

    for (let step = 0; step < MAX_WIZARD_STEPS; step++) {
      await chrome.scripting.executeScript({ target, func: waitForFormContent });
      await fillOneStep(tab, data, step + 1);
      if (await userStopped()) break;

      const [{ result: adv }] = await chrome.scripting.executeScript({ target, func: clickAdvance });
      if (!adv) break; // no Next/Continue button — final step (or single-page form)
      let changed = false;
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 800));
        const [{ result: sig }] = await chrome.scripting.executeScript({ target, func: pageSig });
        if (sig !== adv.sig) { changed = true; break; }
      }
      if (!changed) {
        // validation likely blocked the advance — stop and let the user fix it
        await chrome.scripting.executeScript({
          target,
          func: (msg) => {
            const t = document.getElementById("__dispatch_toast");
            if (t) t.innerHTML += `<br><span style="color:#f87171">${msg}</span>`;
          },
          args: ["Couldn't advance past this step — a required field probably needs you. Fix it and click the icon again."],
        });
        break;
      }
    }
  } catch (e) {
    await chrome.scripting.executeScript({
      target,
      func: (msg) => alert("Dispatch Fill: " + msg + "\nIs the dashboard running at localhost:4310?"),
      args: [String(e.message || e)],
    });
  }
});

// One fill pass over the currently visible form content.
async function fillOneStep(tab, data, stepNum) {
  const target = { tabId: tab.id };
  const [{ result }] = await chrome.scripting.executeScript({
    target,
    func: fillForm,
    args: [data, stepNum],
  });

    // Phase 2 (parallel): LLM-answer custom questions in chunks so answers land
    // progressively, and generate + attach the cover letter when the form wants one.
    const leftover = result?.fields || [];
    const errors = [];
    const tasks = [];

    const CHUNK = 3; // small chunks land progressively and update per-question status
    for (let i = 0; i < leftover.length; i += CHUNK) {
      const fields = leftover.slice(i, i + CHUNK);
      tasks.push((async () => {
        try {
          const ans = await fetch(`${BASE}/api/answers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // title/pageText ground answers in the job page even without a DB match
            body: JSON.stringify({ url: tab.url, fields, title: result.page?.title, pageText: result.page?.text }),
          });
          const payload = ans.ok ? await ans.json() : { answers: [] };
          if (!ans.ok || payload.error) errors.push(payload.error || `HTTP ${ans.status}`);
          // Attach each answer's question label/type so the applier can re-locate
          // fields by label — pages like Google Forms re-render and stale element
          // references end up pointing at the WRONG fields.
          const enriched = (payload.answers || []).map((a) => {
            const f = fields.find((x) => x.key === a.key);
            return { ...a, label: f?.label || "", type: f?.type || "text" };
          });
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: applyAnswers,
            args: [enriched, leftover.length, false],
          });
        } catch (e) {
          errors.push(String(e.message || e));
        }
      })());
    }

    if (result?.needCover) {
      tasks.push((async () => {
        try {
          const res = await fetch(`${BASE}/api/cover-letter`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: tab.url, title: result.page?.title, pageText: result.page?.text }),
          });
          if (!res.ok) throw new Error(`cover letter HTTP ${res.status}`);
          const { pdfB64, filename } = await res.json();
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: attachCoverLetter,
            args: [pdfB64, filename],
          });
        } catch (e) {
          errors.push("cover letter: " + String(e.message || e));
        }
      })());
    }

    await Promise.all(tasks);

    // Google Forms resume upload: open the Drive picker and hand it the file
    if (result?.needGFormUpload) {
      try {
        const [{ result: clicked }] = await chrome.scripting.executeScript({ target, func: gformClickAddFile });
        if (clicked) {
          let attached = 0;
          for (let i = 0; i < 12 && !attached; i++) {
            await new Promise((r) => setTimeout(r, 900));
            const results = await chrome.scripting.executeScript({
              target: { tabId: tab.id, allFrames: true },
              func: gformPickerAttach,
              args: [data.resumeB64, data.resumeName || "Resume.pdf"],
            });
            attached = results.reduce((s, r) => s + (r?.result || 0), 0);
          }
          let done = false;
          for (let i = 0; i < 15 && !done; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            const [{ result: st }] = await chrome.scripting.executeScript({ target, func: gformUploadDone, args: [data.resumeName || ".pdf"] });
            done = !!st?.chip && !st?.pickerOpen;
          }
          await chrome.scripting.executeScript({
            target,
            func: gformToastNote,
            args: done
              ? ["Resume uploaded through the Drive picker.", "#a78bfa"]
              : ["Couldn't drive Google's file picker — click Add file and pick the resume yourself.", "#f87171"],
          });
        }
      } catch { /* picker frames can be uninjectable; the toast fallback covers it */ }
    }

    // ATSes that parse the resume (Ashby) re-render seconds after upload and can
    // wipe values we set — wait out the re-render, then re-apply identity fills.
    if ((result?.filled || []).some((f) => /resume/.test(f))) {
      await new Promise((r) => setTimeout(r, 2500));
    }
    await chrome.scripting.executeScript({ target, func: reapplyInstantFills, args: [data] });
    // Finalizer always runs: updates the toast and offers the Submit button
    await chrome.scripting.executeScript({
      target,
      func: applyAnswers,
      args: [[], leftover.length, true],
    });
    if (tasks.length && errors.length >= tasks.length) throw new Error(errors[0]);
}

// Injected late in the pass: re-fill identity fields that a re-render cleared.
function reapplyInstantFills(data) {
  if (globalThis.__dispatchStop) return 0;
  const setVal = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const getLabel = (el) => {
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent.trim();
      } catch { /* bad id */ }
    }
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    return (el.closest("label")?.textContent || el.getAttribute("aria-label") ||
            el.closest('[role="listitem"]')?.querySelector('[role="heading"]')?.textContent ||
            el.placeholder || el.name || "").trim();
  };
  const instantValue = (label) => {
    const l = label.toLowerCase().replace(/[*:]/g, " ").replace(/\s+/g, " ").trim();
    if (/^(full |your )?name$/.test(l) || /^name (of|as per)/.test(l)) return data.name;
    if (/e-?mail/.test(l) && !/manager|referr/.test(l)) return data.email;
    if (/(contact|phone|mobile|whatsapp)\s*(no|number|#)?$/.test(l) || /^(contact|phone|mobile)\b/.test(l)) {
      return /number|no\b|digit/.test(l) ? data.phone.replace(/[^\d+]/g, "") : data.phone;
    }
    if (/github/.test(l)) return data.github;
    if (/linkedin/.test(l)) return data.linkedin || "";
    if (/^(current )?(city|location)$/.test(l)) return data.location || "";
    return null;
  };
  let n = 0;
  document.querySelectorAll(
    'input[type="text"], input[type="url"], input[type="email"], input[type="tel"], input:not([type])'
  ).forEach((el) => {
    if (el.value || el.disabled || el.offsetParent === null) return;
    const iv = instantValue(getLabel(el));
    if (iv) { setVal(el, iv); n++; }
  });
  return n;
}

// Injected: wait (up to 8s) for form controls to render — SPA steps load lazily.
async function waitForFormContent() {
  const hasControls = () =>
    [...document.querySelectorAll('input, textarea, select, [role="listbox"], [role="radio"]')]
      .some((el) => el.offsetParent !== null || el.type === "file");
  for (let i = 0; i < 16; i++) {
    if (hasControls()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// Injected: cheap content signature to detect wizard step changes.
function pageSig() {
  const t = document.body.innerText || "";
  return t.length + ":" + t.slice(0, 300);
}

// Injected: click a Next/Continue-style wizard button. NEVER Submit/Apply.
function clickAdvance() {
  const cands = [...document.querySelectorAll('button, input[type="button"], a[role="button"]')];
  const btn = cands.find((b) => {
    if (b.disabled || b.offsetParent === null || b.getAttribute("aria-disabled") === "true") return false;
    const t = ((b.innerText || b.value || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
    if (/submit|apply|finish|send/.test(t)) return false;
    return /^(next|continue|save and continue|save & continue|next step|proceed)$/.test(t) || /^next\b/.test(t);
  });
  if (!btn) return null;
  const t = document.body.innerText || "";
  const sig = t.length + ":" + t.slice(0, 300);
  btn.click();
  return { sig };
}

// Injected into the page. Must be self-contained.
async function fillForm(data, stepNum) {
  document.getElementById("__dispatch_toast")?.remove();
  globalThis.__dispatchAnswered = 0;
  globalThis.__dispatchStop = false; // fresh run
  const filled = [];

  const setVal = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, v); // native setter so React/Vue controlled inputs register it
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };

  const visible = (el) => el.offsetParent !== null;

  const pick = (selectors) => {
    for (const s of selectors) {
      for (const el of document.querySelectorAll(s)) {
        if (visible(el) && !el.value && !el.disabled && el.type !== "hidden") return el;
      }
    }
    return null;
  };

  const fill = (selectors, value, label) => {
    if (!value) return;
    const el = pick(selectors);
    if (el) { setVal(el, value); filled.push(label); }
  };

  fill(['#first_name', 'input[name="first_name"]', 'input[autocomplete="given-name"]',
        'input[id*="first" i]', 'input[placeholder*="first name" i]'], data.firstName, "first name");
  fill(['#last_name', 'input[name="last_name"]', 'input[autocomplete="family-name"]',
        'input[id*="last" i]', 'input[placeholder*="last name" i]'], data.lastName, "last name");
  fill(['input[id*="_systemfield_name"]', 'input[name="name"]', 'input[autocomplete="name"]',
        'input[placeholder*="full name" i]'], data.name, "full name");
  fill(['input[type="email"]', '#email', 'input[name="email"]', 'input[id*="email" i]'], data.email, "email");
  fill(['input[type="tel"]', '#phone', 'input[name="phone"]', 'input[id*="phone" i]'], data.phone, "phone");
  fill(['input[id*="linkedin" i]', 'input[name*="linkedin" i]', 'input[placeholder*="linkedin" i]',
        'input[name*="urls[LinkedIn]" i]', 'input[aria-label*="linkedin" i]'], data.linkedin, "linkedin");
  fill(['input[id*="github" i]', 'input[name*="github" i]', 'input[placeholder*="github" i]',
        'input[name*="urls[GitHub]" i]'], data.github, "github");
  // Greenhouse hides the cover letter textarea behind an "Enter manually" button
  if (data.draft) {
    const manualBtn = [...document.querySelectorAll("button")].find((b) => /enter manually/i.test(b.textContent || ""));
    if (manualBtn) {
      manualBtn.click();
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  fill(['#cover_letter_text', 'textarea[name="comments"]', 'textarea[name*="cover" i]',
        'textarea[id*="cover" i]', 'textarea[placeholder*="cover" i]', 'form textarea'],
       data.draft, "message");

  // Classify file inputs by the nearest surrounding text that names them —
  // pages like Kula have separate Resume and Cover Letter drop zones.
  const classifyFileInput = (input) => {
    const self = `${input.name || ""} ${input.id || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/cover/.test(self)) return "cover";
    if (/resume|\bcv\b/.test(self)) return "resume";
    let node = input.parentElement;
    for (let hops = 0; node && hops < 6; hops++) {
      const t = (node.innerText || "").toLowerCase();
      const hasCover = /cover\s*letter/.test(t);
      const hasResume = /resume|\bcv\b/.test(t);
      if (hasCover !== hasResume) return hasCover ? "cover" : "resume";
      if (hasCover && hasResume) return "unknown"; // ambiguous container holds both sections
      node = node.parentElement;
    }
    return "unknown";
  };
  const fileInputs = [...document.querySelectorAll('input[type="file"]')];
  const fileKinds = fileInputs.map(classifyFileInput);

  // Dropzone finder for uploaders with no reachable <input type=file> (Rippling etc.):
  // an element with drop/upload wording whose nearest exclusive ancestor names the kind.
  const findDropzone = (kindRe, otherRe) => {
    const drops = [...document.querySelectorAll("div, section, button, label")].filter((el) => {
      const t = (el.innerText || "").toLowerCase();
      return t.length > 0 && t.length < 200 && /drop or select|drag and drop|click to upload|browse files|drop files/.test(t);
    });
    for (const el of drops.reverse()) { // innermost matches first
      let node = el;
      for (let hops = 0; node && hops < 6; hops++) {
        const t = (node.innerText || "").toLowerCase();
        const mine = kindRe.test(t), other = otherRe.test(t);
        if (mine && !other) return el;
        if (other) break;
        node = node.parentElement;
      }
    }
    return null;
  };
  const dropFileOn = (zone, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
  };

  if (data.resumeB64) {
    try {
      const bin = atob(data.resumeB64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], data.resumeName || "Resume.pdf", { type: "application/pdf" });
      const target =
        fileInputs[fileKinds.indexOf("resume")] ||
        fileInputs[fileKinds.indexOf("unknown")] ||
        (fileInputs.length === 1 ? fileInputs[0] : null);
      if (target && !target.files?.length) {
        const dt = new DataTransfer();
        dt.items.add(file);
        target.files = dt.files;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        filled.push("resume");
      } else if (!target) {
        const zone = findDropzone(/resume|\bcv\b/, /cover\s*letter/);
        if (zone) { dropFileOn(zone, file); filled.push("resume (dropped)"); }
      }
    } catch (e) { /* no file input or blocked */ }
  }
  const coverIdx = fileKinds.indexOf("cover");
  const needCover =
    (coverIdx !== -1 && !fileInputs[coverIdx].files?.length) ||
    (coverIdx === -1 && !!findDropzone(/cover\s*letter/, /resume|\bcv\b/));

  // Google Forms file-upload questions use a Drive picker dialog, not a file input
  const gformAddFile = [...document.querySelectorAll("div[role='listitem'] div[role='button'], div[role='listitem'] button")]
    .find((b) => /^add file$/i.test((b.innerText || "").trim()) && b.offsetParent !== null);
  const needGFormUpload = !!gformAddFile && !!data.resumeB64;

  // Phase 2 prep: collect remaining unanswered fields for LLM answering.
  // Element handles live in this isolated world and survive between injections.
  const fields = [];
  const refs = {};
  let idx = 0;
  const getLabel = (el) => {
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent.trim();
      } catch { /* bad id */ }
    }
    const wrap = el.closest("label");
    if (wrap) return wrap.textContent.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      // may reference multiple ids (Google Forms: question + description)
      const text = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (text) return text;
    }
    if (el.getAttribute("aria-label")) return el.getAttribute("aria-label").trim();
    // Google Forms: question heading lives in the enclosing listitem
    const listitem = el.closest('[role="listitem"]');
    const heading = listitem?.querySelector('[role="heading"]');
    if (heading) return heading.textContent.trim();
    const holder = el.closest("div, fieldset, li");
    const legend = holder?.querySelector("label, legend, .label, [class*='label' i]");
    return (legend?.textContent || el.placeholder || el.name || "").trim();
  };

  // Instant answers for fields whose label plainly says what they are —
  // covers Google Forms and other nonstandard markup without waiting on the LLM.
  const instantValue = (label) => {
    const l = label.toLowerCase().replace(/[*:]/g, " ").replace(/\s+/g, " ").trim();
    if (/^(full |your )?name$/.test(l) || /^name (of|as per)/.test(l)) return data.name;
    if (/e-?mail/.test(l) && !/manager|referr/.test(l)) return data.email;
    if (/(contact|phone|mobile|whatsapp)\s*(no|number|#)?$/.test(l) || /^(contact|phone|mobile)\b/.test(l)) {
      return /number|no\b|digit/.test(l) ? data.phone.replace(/[^\d+]/g, "") : data.phone;
    }
    if (/github/.test(l)) return data.github;
    if (/linkedin/.test(l)) return data.linkedin || "";
    if (/^(current )?(city|location)$/.test(l)) return data.location || "";
    return null;
  };
  // Junk guard: chrome UI, captchas, site chrome — not application fields
  const junk = (el) =>
    !!el.closest("nav, header, footer, [role='search'], #__dispatch_toast") ||
    /captcha/i.test(`${el.id || ""} ${el.name || ""} ${el.className || ""}`);

  const addField = (el, type, options) => {
    if (junk(el)) return;
    const label = getLabel(el).slice(0, 250);
    if (!label || /^search\b/i.test(label)) return;
    const key = "f" + idx++;
    refs[key] = el;
    fields.push({ key, label, type, options, required: !!el.required });
  };

  // NOTE: collectors are document-wide, not form-scoped — Ashby and other React
  // ATSes render application fields with no <form> element at all.
  document.querySelectorAll("select").forEach((el) => {
    const empty = el.multiple ? el.selectedOptions.length === 0 : !el.value;
    if (visible(el) && empty) {
      const label = getLabel(el);
      const maxMatch = label.match(/(?:up to|choose|select|pick)\s+(one|two|three|four|five|\d+)/i);
      const words = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const key = "f" + idx++;
      refs[key] = el;
      fields.push({
        key,
        label: label.slice(0, 250),
        type: el.multiple ? "multiselect" : "select",
        options: [...el.options].map((o) => o.textContent.trim()).filter((t) => t && !/^select\b/i.test(t)).slice(0, 30),
        maxChoices: el.multiple ? (maxMatch ? words[maxMatch[1].toLowerCase()] || parseInt(maxMatch[1]) : 3) : 1,
        required: !!el.required,
      });
    }
  });
  const radioGroups = {};
  document.querySelectorAll('input[type="radio"]').forEach((el) => {
    if (junk(el)) return;
    (radioGroups[el.name] ||= []).push(el);
  });
  for (const group of Object.values(radioGroups)) {
    if (group.some((r) => r.checked)) continue;
    const key = "f" + idx++;
    refs[key] = group;
    const holder = group[0].closest("fieldset, div[role='radiogroup'], div");
    fields.push({
      key,
      label: (holder?.querySelector("legend, label, [class*='label' i]")?.textContent || getLabel(group[0])).trim().slice(0, 250),
      type: "radio",
      options: group.map((r) => (r.closest("label") || document.querySelector(`label[for="${CSS.escape(r.id || "")}"]`))?.textContent?.trim() || r.value).slice(0, 15),
    });
  }
  document.querySelectorAll('input[type="date"]').forEach((el) => {
    if (visible(el) && !el.value && !el.disabled) addField(el, "date");
  });
  document.querySelectorAll(
    'input[type="text"], input[type="number"], input[type="url"], input[type="email"], input[type="tel"], input:not([type]), textarea'
  ).forEach((el) => {
    if (!visible(el) || el.value || el.disabled || junk(el)) return;
    const iv = instantValue(getLabel(el));
    if (iv !== null) {
      if (iv) { setVal(el, iv); filled.push(getLabel(el).slice(0, 30)); }
      return; // identity field: filled from profile (or unknown), never sent to the LLM
    }
    addField(el, el.tagName === "TEXTAREA" ? "textarea" : "text");
  });

  // Button choice groups (Ashby-style Yes/No answers are plain <button>s)
  const seenBtnGroups = new Set();
  document.querySelectorAll("button").forEach((b) => {
    const txt = (b.innerText || "").trim();
    if (!txt || txt.length > 40 || !visible(b) || junk(b)) return;
    if (/submit|apply|next|back|cancel|upload|attach|remove|browse|sign|log ?in|search|choose|select file/i.test(txt)) return;
    const parent = b.parentElement;
    if (!parent || seenBtnGroups.has(parent)) return;
    const sibs = [...parent.children].filter(
      (c) => c.tagName === "BUTTON" && (c.innerText || "").trim() && (c.innerText || "").trim().length <= 40
    );
    if (sibs.length < 2 || sibs.length > 5) return;
    if (sibs.some((s) => /submit|apply|next|back|cancel|upload/i.test(s.innerText || ""))) return;
    seenBtnGroups.add(parent);
    // question = nearest preceding label/heading outside the group
    let q = "";
    let node = parent.parentElement;
    for (let hops = 0; node && hops < 4 && !q; hops++) {
      const cands = [...node.querySelectorAll("label, h1, h2, h3, h4, [class*='label' i]")].filter(
        (l) => !parent.contains(l) && (l.innerText || "").trim().length > 5 &&
               (l.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING)
      );
      if (cands.length) q = cands[cands.length - 1].innerText.trim();
      node = node.parentElement;
    }
    if (!q) return;
    const key = "f" + idx++;
    refs[key] = sibs;
    fields.push({ key, label: q.slice(0, 250), type: "buttons", options: sibs.map((s) => (s.innerText || "").trim()) });
  });

  // Google Forms-style ARIA widgets (div role=radio / role=listbox, no real inputs)
  const ariaRadioGroups = new Map();
  document.querySelectorAll('[role="radio"]').forEach((el) => {
    const group = el.closest('[role="radiogroup"], [role="listitem"]');
    if (!group) return;
    if (!ariaRadioGroups.has(group)) ariaRadioGroups.set(group, []);
    ariaRadioGroups.get(group).push(el);
  });
  for (const [group, radios] of ariaRadioGroups) {
    if (radios.some((r) => r.getAttribute("aria-checked") === "true")) continue;
    const key = "f" + idx++;
    refs[key] = radios;
    const holder = group.closest('[role="listitem"]') || group;
    fields.push({
      key,
      label: (holder.querySelector('[role="heading"]')?.textContent || getLabel(radios[0])).trim().slice(0, 250),
      type: "radio",
      options: radios.map((r) => (r.getAttribute("aria-label") || r.textContent).trim()).filter(Boolean).slice(0, 15),
    });
  }
  document.querySelectorAll('[role="listbox"]').forEach((el) => {
    if (!visible(el)) return;
    const listitem = el.closest('[role="listitem"]');
    const options = [...(listitem || el).querySelectorAll('[role="option"]')]
      .map((o) => o.textContent.trim())
      .filter((t) => t && !/^choose$/i.test(t))
      .slice(0, 30);
    if (!options.length) return;
    const key = "f" + idx++;
    refs[key] = el;
    fields.push({
      key,
      label: (listitem?.querySelector('[role="heading"]')?.textContent || getLabel(el)).trim().slice(0, 250),
      type: "select",
      options,
    });
  });

  globalThis.__dispatchRefs = refs;

  // Toast with what happened
  const toast = document.createElement("div");
  toast.id = "__dispatch_toast";
  toast.style.cssText =
    "position:fixed;top:16px;right:16px;z-index:2147483647;background:#0b1120;color:#e2e8f0;" +
    "border:1px solid #10b981;border-radius:10px;padding:12px 16px;font:13px/1.5 -apple-system,sans-serif;" +
    "box-shadow:0 8px 30px rgba(0,0,0,.4);max-width:320px";
  toast.innerHTML =
    `<button id="__dispatch_stop" title="Stop Dispatch Fill" style="position:absolute;top:6px;right:8px;background:none;border:none;color:#64748b;font:16px -apple-system,sans-serif;cursor:pointer;padding:2px 6px">✕</button>` +
    `<strong style="color:#34d399">Dispatch Fill${stepNum && stepNum > 1 ? ` · step ${stepNum}` : ""}</strong><br>` +
    (filled.length ? `Filled: ${filled.join(", ")}.` : "No known fields found on this page.") +
    (data.matched ? `<br>Draft: ${data.matched}` : data.draft ? "" : "<br>No matching draft for this URL.") +
    (fields.length
      ? `<br><span style="color:#fbbf24">Answering with Claude:</span>` +
        `<ul id="__dispatch_qlist" style="margin:4px 0 0 0;padding:0 0 0 2px;max-height:190px;overflow-y:auto">` +
        fields.slice(0, 20).map((f) => {
          const esc = f.label.slice(0, 48).replace(/&/g, "&amp;").replace(/</g, "&lt;");
          return `<li data-key="${f.key}" data-label="${esc}${f.label.length > 48 ? "…" : ""}" style="color:#94a3b8;list-style:none;margin-top:2px">⏳ ${esc}${f.label.length > 48 ? "…" : ""}</li>`;
        }).join("") +
        `</ul>`
      : "") +
    (needCover ? `<br><span style="color:#a78bfa">Writing a cover letter…</span>` : "") +
    `<br><span style="color:#94a3b8">Review everything before submitting.</span>`;
  toast.style.position = "fixed"; // ensure the ✕ anchors to the toast
  document.body.appendChild(toast);
  document.getElementById("__dispatch_stop").onclick = () => {
    globalThis.__dispatchStop = true;
    toast.remove();
  };

  return {
    filled,
    fields: fields.slice(0, 20),
    needCover,
    needGFormUpload,
    page: { title: document.title, text: (document.body.innerText || "").slice(0, 2500) },
  };
}

// --- Google Forms Drive-picker upload helpers ---
function gformClickAddFile() {
  const btn = [...document.querySelectorAll("div[role='listitem'] div[role='button'], div[role='listitem'] button")]
    .find((b) => /^add file$/i.test((b.innerText || "").trim()) && b.offsetParent !== null);
  if (!btn) return false;
  btn.click();
  return true;
}

// Runs in ALL frames: the Drive picker's upload pane lives in an iframe.
function gformPickerAttach(b64, name) {
  const inputs = [...document.querySelectorAll('input[type="file"]')];
  if (!inputs.length) return 0;
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([arr], name || "Resume.pdf", { type: "application/pdf" });
  const dt = new DataTransfer();
  dt.items.add(file);
  let n = 0;
  for (const input of inputs) {
    try {
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      n++;
    } catch { /* frame may block */ }
  }
  // some picker builds only listen for drops on the drag area
  const dropArea = [...document.querySelectorAll("div")].find((d) => /drag (a )?file|drag files here/i.test(d.innerText || "") && (d.innerText || "").length < 120);
  if (dropArea) {
    for (const type of ["dragenter", "dragover", "drop"]) {
      dropArea.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    n++;
  }
  return n;
}

function gformUploadDone(resumeName) {
  const re = new RegExp((resumeName || ".pdf").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const chip = [...document.querySelectorAll("div[role='listitem']")].some((li) => re.test(li.innerText || "") || /\.pdf\s*[✕×]?/i.test((li.innerText || "").split("\n").slice(-3).join(" ")));
  const pickerOpen = !!document.querySelector(".picker-dialog, iframe[src*='picker']");
  return { chip, pickerOpen };
}

function gformToastNote(msg, color) {
  const t = document.getElementById("__dispatch_toast");
  if (t) t.innerHTML += `<br><span style="color:${color}">${msg}</span>`;
}

// Injected when the cover-letter PDF is ready: attach it to the cover letter file input.
function attachCoverLetter(pdfB64, filename) {
  if (globalThis.__dispatchStop) return;
  const classify = (input) => {
    const self = `${input.name || ""} ${input.id || ""} ${input.getAttribute("aria-label") || ""}`.toLowerCase();
    if (/cover/.test(self)) return "cover";
    let node = input.parentElement;
    for (let hops = 0; node && hops < 6; hops++) {
      const t = (node.innerText || "").toLowerCase();
      const hasCover = /cover\s*letter/.test(t);
      const hasResume = /resume|\bcv\b/.test(t);
      if (hasCover !== hasResume) return hasCover ? "cover" : "resume";
      if (hasCover && hasResume) return "unknown";
      node = node.parentElement;
    }
    return "unknown";
  };
  const input = [...document.querySelectorAll('input[type="file"]')].find((i) => classify(i) === "cover" && !i.files?.length);
  const toast = document.getElementById("__dispatch_toast");
  const bin = atob(pdfB64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const file = new File([arr], filename || "Cover_Letter.pdf", { type: "application/pdf" });

  if (input) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (toast) toast.innerHTML += `<br><span style="color:#a78bfa">Cover letter written and attached.</span>`;
    return;
  }
  // No reachable input — simulate a real drag-and-drop onto the labeled dropzone
  const drops = [...document.querySelectorAll("div, section, button, label")].filter((el) => {
    const t = (el.innerText || "").toLowerCase();
    return t.length > 0 && t.length < 200 && /drop or select|drag and drop|click to upload|browse files|drop files/.test(t);
  });
  let zone = null;
  for (const el of drops.reverse()) {
    let node = el;
    for (let hops = 0; node && hops < 6; hops++) {
      const t = (node.innerText || "").toLowerCase();
      const mine = /cover\s*letter/.test(t), other = /resume|\bcv\b/.test(t);
      if (mine && !other) { zone = el; break; }
      if (other) break;
      node = node.parentElement;
    }
    if (zone) break;
  }
  if (zone) {
    const dt = new DataTransfer();
    dt.items.add(file);
    for (const type of ["dragenter", "dragover", "drop"]) {
      zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
    }
    if (toast) toast.innerHTML += `<br><span style="color:#a78bfa">Cover letter dropped onto the upload zone — check it shows as attached.</span>`;
  } else if (toast) {
    toast.innerHTML += `<br><span style="color:#a78bfa">Cover letter ready but no upload field found.</span>`;
  }
}

// Injected after each answers-API chunk responds. Fills LLM answers,
// amber-highlighted for review. Called with (answers, totalExpected, done).
async function applyAnswers(answers, totalExpected, done) {
  if (globalThis.__dispatchStop) return;
  const refs = globalThis.__dispatchRefs || {};
  const setVal = (el, v) => {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const highlight = (el) => { el.style.outline = "2px dashed #f59e0b"; el.style.outlineOffset = "1px"; };
  const visible = (el) => el.offsetParent !== null;
  const norm = (s) => (s || "").toLowerCase().replace(/[*:]/g, " ").replace(/\s+/g, " ").trim();
  const labelOf = (el) => {
    const labelledby = el.getAttribute?.("aria-labelledby");
    if (labelledby) {
      const t = labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent || "").join(" ").trim();
      if (t) return t;
    }
    if (el.id) {
      try {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.textContent.trim();
      } catch { /* bad id */ }
    }
    const wrap = el.closest?.("label");
    if (wrap) return wrap.textContent.trim();
    if (el.getAttribute?.("aria-label")) return el.getAttribute("aria-label").trim();
    const heading = el.closest?.('[role="listitem"]')?.querySelector('[role="heading"]');
    if (heading) return heading.textContent.trim();
    const holder = el.closest?.("div, fieldset, li");
    const legend = holder?.querySelector("label, legend, .label, [class*='label' i]");
    return (legend?.textContent || el.placeholder || el.name || "").trim();
  };
  const labelMatches = (el, want) => {
    const l = norm(labelOf(el));
    return l && want && (l === want || l.startsWith(want) || want.startsWith(l));
  };
  // Re-locate a field by its question label. Stored references go stale on pages
  // that re-render as values land (Google Forms) and then point at WRONG nodes.
  const findByLabel = (a) => {
    const want = norm(a.label);
    if (!want) return null;
    if (a.type === "radio") {
      const groups = new Map();
      document.querySelectorAll('input[type="radio"], [role="radio"]').forEach((r) => {
        const g = r.closest('[role="radiogroup"], [role="listitem"], fieldset') || r.closest("form");
        if (!g) return;
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
      });
      for (const [g, radios] of groups) {
        const holder = g.closest('[role="listitem"]') || g;
        const gl = norm(holder.querySelector('[role="heading"], legend')?.textContent || labelOf(radios[0]));
        if (gl && (gl === want || gl.startsWith(want) || want.startsWith(gl))) return radios;
      }
      return null;
    }
    if (a.type === "buttons") {
      for (const parent of new Set([...document.querySelectorAll("button")].map((b) => b.parentElement))) {
        if (!parent) continue;
        const sibs = [...parent.children].filter((c) => c.tagName === "BUTTON" && (c.innerText || "").trim());
        if (sibs.length < 2 || sibs.length > 5) continue;
        let node = parent.parentElement;
        for (let hops = 0; node && hops < 4; hops++) {
          const hit = [...node.querySelectorAll("label, h1, h2, h3, h4, [class*='label' i]")].some(
            (l) => !parent.contains(l) && norm(l.innerText).startsWith(want.slice(0, 50))
          );
          if (hit) return sibs;
          node = node.parentElement;
        }
      }
      return null;
    }
    if (a.type === "select" || a.type === "multiselect") {
      for (const el of document.querySelectorAll("select")) if (labelMatches(el, want)) return el;
      for (const el of document.querySelectorAll('[role="listbox"]')) {
        const gl = norm(el.closest('[role="listitem"]')?.querySelector('[role="heading"]')?.textContent || labelOf(el));
        if (gl && (gl === want || gl.startsWith(want) || want.startsWith(gl))) return el;
      }
      return null;
    }
    for (const el of document.querySelectorAll('input[type="text"], input[type="number"], input[type="url"], input:not([type]), textarea')) {
      if (!visible(el) || el.disabled) continue;
      if (labelMatches(el, want)) return el;
    }
    return null;
  };
  const resolve = (a) => {
    const byLabel = findByLabel(a);
    if (byLabel) return byLabel; // label match is ground truth
    const ref = refs[a.key];
    const alive = ref && (Array.isArray(ref) ? ref.every((r) => document.contains(r)) : document.contains(ref));
    return alive ? ref : null;
  };
  let applied = 0;

  const markQ = (key, icon, color) => {
    let li = null;
    try { li = document.querySelector(`#__dispatch_qlist li[data-key="${CSS.escape(key)}"]`); } catch { /* bad key */ }
    if (li) { li.style.color = color; li.textContent = `${icon} ${li.dataset.label}`; }
  };

  for (const a of answers) {
    if (!a.value || (Array.isArray(a.value) && !a.value.length)) {
      markQ(a.key, "·", "#64748b"); // honestly left blank (unknown/disqualifier)
      continue;
    }
    const ref = resolve(a);
    if (!ref) { markQ(a.key, "✗", "#f87171"); continue; }
    let ok = false;
    if (!Array.isArray(ref) && ref.tagName === "SELECT" && ref.multiple) {
      const wanted = (Array.isArray(a.value) ? a.value : String(a.value).split(/\s*[;,]\s*/)).map((v) => v.trim().toLowerCase()).filter(Boolean);
      let hits = 0;
      for (const opt of ref.options) {
        const t = opt.textContent.trim().toLowerCase();
        if (wanted.some((w) => t === w || t.includes(w))) { opt.selected = true; hits++; }
      }
      if (hits) {
        ref.dispatchEvent(new Event("change", { bubbles: true }));
        highlight(ref);
        applied++;
        ok = true;
      }
      markQ(a.key, ok ? "✓" : "✗", ok ? "#34d399" : "#f87171");
      continue;
    }
    const val = (Array.isArray(a.value) ? a.value.join(", ") : String(a.value)).trim();
    if (Array.isArray(ref)) {
      // choice group (radio inputs, ARIA divs, or plain buttons): click the matching option
      const optLabel = (r) =>
        r.tagName === "BUTTON"
          ? (r.innerText || "").trim()
          : r.getAttribute?.("role") === "radio"
            ? (r.getAttribute("aria-label") || r.textContent).trim()
            : (r.closest("label") || document.querySelector(`label[for="${CSS.escape(r.id || "")}"]`))?.textContent?.trim() || r.value;
      const target = ref.find((r) => {
        const lbl = (optLabel(r) || "").toLowerCase();
        return lbl === val.toLowerCase() || lbl.includes(val.toLowerCase());
      });
      if (target) { target.click(); highlight(target.closest("label") || target); applied++; ok = true; }
    } else if (ref.getAttribute && ref.getAttribute("role") === "listbox") {
      // ARIA dropdown (Google Forms): open it, then click the matching option
      ref.click();
      await new Promise((r) => setTimeout(r, 400));
      const scope = ref.closest('[role="listitem"]') || document;
      const opts = [...scope.querySelectorAll('[role="option"]')];
      const opt = opts.find((o) => o.textContent.trim().toLowerCase() === val.toLowerCase())
        || opts.find((o) => o.textContent.trim().toLowerCase().includes(val.toLowerCase()));
      if (opt) {
        opt.click();
        await new Promise((r) => setTimeout(r, 200));
        highlight(ref);
        applied++;
        ok = true;
      } else {
        ref.click(); // close it again
      }
    } else if (ref.tagName === "SELECT") {
      const opt = [...ref.options].find((o) => o.textContent.trim().toLowerCase() === val.toLowerCase())
        || [...ref.options].find((o) => o.textContent.trim().toLowerCase().includes(val.toLowerCase()));
      if (opt) { ref.value = opt.value; ref.dispatchEvent(new Event("change", { bubbles: true })); highlight(ref); applied++; ok = true; }
    } else {
      setVal(ref, val);
      highlight(ref);
      applied++;
      ok = true;
    }
    markQ(a.key, ok ? "✓" : "✗", ok ? "#34d399" : "#f87171");
  }

  // Progressive toast: accumulate across chunks, finalize on the done call
  globalThis.__dispatchAnswered = (globalThis.__dispatchAnswered || 0) + applied;
  const toast = document.getElementById("__dispatch_toast");
  if (toast && totalExpected > 0) {
    let line = document.getElementById("__dispatch_progress");
    if (!line) {
      line = document.createElement("span");
      line.id = "__dispatch_progress";
      line.style.color = "#fbbf24";
      toast.appendChild(document.createElement("br"));
      toast.appendChild(line);
    }
    const n = globalThis.__dispatchAnswered;
    line.textContent = done
      ? `Answered ${n}/${totalExpected} questions (amber outline). Check them before submitting.`
      : `Answered ${n}/${totalExpected} so far…`;
  }
  if (done && toast) {
    // Offer one-click submit from the toast — filling never submits by itself
    const findSubmit = () => {
      const cands = [...document.querySelectorAll('button, input[type="submit"]')];
      return cands.find((b) => {
        if (b.disabled || b.offsetParent === null || b.id === "__dispatch_submit") return false;
        const t = ((b.innerText || b.value || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
        return /^(submit|apply|send)\b/.test(t) || /submit application|apply now|send application|submit form/.test(t);
      });
    };
    if (findSubmit() && !document.getElementById("__dispatch_submit")) {
      const btn = document.createElement("button");
      btn.id = "__dispatch_submit";
      btn.textContent = "Reviewed it? Submit application →";
      btn.style.cssText =
        "margin-top:10px;display:block;background:#059669;color:#fff;border:none;border-radius:6px;" +
        "padding:7px 12px;font:600 13px -apple-system,sans-serif;cursor:pointer";
      btn.onclick = () => {
        const s = findSubmit();
        if (s) { s.click(); btn.textContent = "Submitted ✓"; btn.disabled = true; setTimeout(() => toast.remove(), 4000); }
        else { btn.textContent = "Submit button not found, submit manually"; }
      };
      toast.appendChild(btn);
    }
    setTimeout(() => toast.remove(), 120000);
  }
}
