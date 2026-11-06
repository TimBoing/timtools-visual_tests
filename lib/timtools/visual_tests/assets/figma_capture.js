// figma_capture.js — runs in the page (injected by VisualTestCase#figma_export, alongside
// the vendored @builder.io/html-to-figma bundle). Exposes window.__figmaCapture(htmlToFigma,
// selector) which returns a Promise of the `{ layers: [...] }` JSON string ready for the
// Layers JSON Importer Figma plugin.
//
// It runs htmlToFigma in useFrames mode (nested DOM tree) and enriches the result with things
// the lib drops: BEM/CSS class names, font weights, body bg, opacity, gradients, SVG colors,
// Font Awesome glyphs, form controls, images, and overlay (modal) z-ordering.
(function () {
  // --- CSS color parsing -----------------------------------------------------
  const cssColorToFill = (str) => {
    if (!str) return null;
    const a0 = str.indexOf("("), b0 = str.indexOf(")");
    if (a0 < 0 || b0 < 0) return null;
    const p = str.slice(a0 + 1, b0).split(",").map((s) => parseFloat(s));
    if (p.length < 3) return null;
    const alpha = p.length > 3 ? p[3] : 1;
    if (!alpha) return null;
    return { type: "SOLID", color: { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255 }, opacity: alpha };
  };
  const cssColorToRGBA = (str) => {
    if (!str) return null;
    const a0 = str.indexOf("("), b0 = str.lastIndexOf(")");
    if (a0 < 0 || b0 < 0) return null;
    const p = str.slice(a0 + 1, b0).split(",").map((s) => parseFloat(s));
    if (p.length < 3) return null;
    return { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 };
  };

  // --- CSS linear-gradient -> Figma GRADIENT_LINEAR paint --------------------
  const splitTopLevel = (s) => {
    const out = []; let depth = 0, cur = "";
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  };
  const parseAngle = (tok) => {
    tok = tok.trim();
    if (tok.indexOf("deg") !== -1) return parseFloat(tok);
    const dirs = { "to top": 0, "to right": 90, "to bottom": 180, "to left": 270,
      "to top right": 45, "to bottom right": 135, "to bottom left": 225, "to top left": 315 };
    return dirs[tok] != null ? dirs[tok] : 180;
  };
  const transformFromAngle = (deg) => {
    const rot = (deg - 90) * Math.PI / 180; // 90deg (to right) => identity (left->right)
    const c = Math.cos(rot), s = Math.sin(rot);
    return [[c, -s, 0.5 - 0.5 * c + 0.5 * s], [s, c, 0.5 - 0.5 * s - 0.5 * c]];
  };
  const parseLinearGradient = (str) => {
    const at = str.indexOf("linear-gradient(");
    if (at === -1) return null;
    let i = at + "linear-gradient(".length, depth = 1, inner = "";
    for (; i < str.length && depth > 0; i++) {
      const ch = str[i];
      if (ch === "(") depth++;
      else if (ch === ")") { depth--; if (depth === 0) break; }
      inner += ch;
    }
    const parts = splitTopLevel(inner);
    if (!parts.length) return null;
    let angle = 180, stopParts = parts;
    if (parts[0].indexOf("deg") !== -1 || parts[0].indexOf("to ") === 0) { angle = parseAngle(parts[0]); stopParts = parts.slice(1); }
    const stops = [];
    stopParts.forEach((p) => {
      let colorStr = p, pos = null;
      const close = p.lastIndexOf(")");
      if (close !== -1 && close < p.length - 1) {
        const rest = p.slice(close + 1).trim();
        if (rest.indexOf("%") !== -1) pos = parseFloat(rest) / 100;
        colorStr = p.slice(0, close + 1);
      }
      const color = cssColorToRGBA(colorStr);
      if (color) stops.push({ position: pos, color: color });
    });
    if (stops.length < 2) return null;
    stops.forEach((s, idx) => { if (s.position == null) s.position = idx / (stops.length - 1); });
    return {
      type: "GRADIENT_LINEAR",
      gradientStops: stops.map((s) => ({ position: Math.max(0, Math.min(1, s.position)), color: s.color })),
      gradientTransform: transformFromAngle(angle),
    };
  };

  // --- Pre-passes (mutate the DOM before capture) ----------------------------

  // Scroll containers (overflow-y auto/scroll/hidden whose content is taller than the box)
  // only show their visible slice in the browser, but a full-page design capture wants the
  // whole content unrolled. Release the height/overflow constraint so the element — and, via
  // flex/normal flow, its ancestors — lay out at full content height and html-to-figma reads
  // the true (tall) frame. Guarded by scrollHeight > clientHeight so genuinely-fitting clipped
  // boxes (avatars with border-radius, text-overflow ellipsis cells) are left untouched.
  const expandScrollContainers = () => {
    // Iterate: expanding the innermost scroller un-clips its content, which only then makes an
    // ancestor's scrollHeight exceed its clientHeight — so the release cascades outward over
    // successive passes (inner scroll box -> the height:100vh/overflow:hidden wrapper -> body).
    // Ancestors with overflow:visible aren't matched directly but follow via flex/normal flow
    // once their height-constraining wrapper is released. Bounded pass count as a safety net.
    for (let pass = 0; pass < 8; pass++) {
      const targets = [];
      document.querySelectorAll("*").forEach((el) => {
        const oy = window.getComputedStyle(el).overflowY;
        if ((oy === "auto" || oy === "scroll" || oy === "hidden") &&
            el.scrollHeight > el.clientHeight + 1) {
          targets.push(el);
        }
      });
      if (!targets.length) break;
      targets.forEach((el) => {
        // Pin to an explicit content height rather than `auto`: on a flex container `auto`
        // can resolve to min-content and collapse the box; scrollHeight is the real extent.
        el.style.height = el.scrollHeight + "px";
        el.style.maxHeight = "none";
        el.style.overflowY = "visible";
      });
    }
  };

  // Font Awesome renders via ::before glyphs in a webfont — htmlToFigma can't capture
  // pseudo-elements. Draw each glyph (using the loaded FA font) onto a canvas and replace
  // the <i> with an <img>, which the capture then handles like any image.
  const rasterizeFontAwesome = async () => {
    try { await document.fonts.ready; } catch (e) { /* ignore */ }
    document.querySelectorAll("i[class*='fa-'], span[class*='fa-']").forEach((el) => {
      const cs = window.getComputedStyle(el, "::before");
      let glyph = cs.content;
      if (!glyph || glyph === "none" || glyph === "normal") return;
      if (glyph.length >= 2 && (glyph[0] === '"' || glyph[0] === "'")) glyph = glyph.slice(1, -1);
      if (!glyph) return;
      const size = parseFloat(cs.fontSize) || 16;
      const scale = 3; // hi-dpi so small icons stay crisp
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(size * scale); canvas.height = Math.ceil(size * scale);
      const ctx = canvas.getContext("2d");
      ctx.scale(scale, scale);
      ctx.font = (cs.fontWeight || "900") + " " + size + "px " + cs.fontFamily;
      ctx.fillStyle = cs.color || "#000";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(glyph, size / 2, size / 2);
      let dataUrl;
      try { dataUrl = canvas.toDataURL("image/png"); } catch (e) { return; }
      const img = document.createElement("img");
      img.src = dataUrl;
      img.className = el.className; // keep the fa-* classes for the layer name
      img.style.width = size + "px"; img.style.height = size + "px";
      img.style.display = "inline-block"; img.style.verticalAlign = "middle";
      // Preserve the original element's margins (element-selector CSS won't reach the <img>).
      const ecs = window.getComputedStyle(el);
      img.style.marginTop = ecs.marginTop; img.style.marginRight = ecs.marginRight;
      img.style.marginBottom = ecs.marginBottom; img.style.marginLeft = ecs.marginLeft;
      // Preserve positioning (e.g. position:absolute icons overlaid on their container).
      // The CSS selector `i { ... }` won't match <img>, so the computed position would be
      // lost — the icon ends up in the normal flow at the wrong location.
      if (ecs.position !== "static") {
        img.style.position = ecs.position;
        ["top", "right", "bottom", "left"].forEach((s) => {
          if (ecs[s] && ecs[s] !== "auto") img.style[s] = ecs[s];
        });
      }
      el.replaceWith(img);
    });
  };

  // Whether an element is actually rendered. htmlToFigma skips non-rendered nodes, so our
  // pre-passes (which replace a control with a visible stand-in BEFORE capture) must skip them
  // too — otherwise a display:none control is resurrected as a visible box, e.g. a hidden
  // `f.submit "Search", style: "display: none"` reappearing as a phantom "Search" button.
  const isRendered = (el) => {
    if (el.getClientRects().length === 0) return false; // display:none on self or an ancestor
    const cs = window.getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  // Screen-reader-only elements (Bootstrap `.visually-hidden`, common `.sr-only`) are clipped to
  // a 1px box on screen, but htmlToFigma measures their text node's *natural* size via a Range —
  // so the label reappears full-size and overlapping (e.g. the mobile bottom-nav icons' labels).
  // They're invisible to a sighted user -> drop them from a visual capture. Detected by the
  // clip / clip-path signature so it works regardless of the class name.
  const hideVisuallyHidden = () => {
    document.querySelectorAll("*").forEach((el) => {
      const cs = window.getComputedStyle(el);
      if (cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)") {
        el.style.setProperty("display", "none", "important");
      }
    });
  };

  // Native checkbox/radio inputs aren't rendered by htmlToFigma (OS-drawn) -> replace each
  // with a styled box (border + fill + checkmark if checked) so they're visible in Figma.
  const renderFormControls = () => {
    document.querySelectorAll("input[type=checkbox], input[type=radio]").forEach((el) => {
      if (!isRendered(el)) return;
      const r = el.getBoundingClientRect();
      const size = Math.max(Math.round(r.width) || 0, 14);
      const radio = el.type === "radio";
      const cs = window.getComputedStyle(el);
      const accent = (cs.accentColor && cs.accentColor !== "auto") ? cs.accentColor : "rgb(13,153,255)";
      const box = document.createElement("span");
      box.className = el.className;
      const s = box.style;
      s.display = "inline-block"; s.boxSizing = "border-box";
      s.width = size + "px"; s.height = size + "px"; s.verticalAlign = "middle";
      // Preserve the input's margins (the `input[...]` selector won't match the <span>).
      s.marginTop = cs.marginTop; s.marginRight = cs.marginRight;
      s.marginBottom = cs.marginBottom; s.marginLeft = cs.marginLeft;
      s.borderRadius = radio ? "50%" : "3px";
      s.border = "1.5px solid " + (el.checked ? accent : "rgb(136,136,136)");
      s.background = el.checked ? accent : "rgb(255,255,255)";
      if (el.checked && !radio) {
        box.textContent = "✓";
        s.color = "rgb(255,255,255)"; s.textAlign = "center";
        s.fontSize = Math.round(size * 0.8) + "px"; s.lineHeight = size + "px";
      }
      el.replaceWith(box);
    });
  };

  // Native <select>/<input>/<textarea> display their text (selected option, value, or
  // placeholder) via browser-drawn content — there's no text node in the DOM, so htmlToFigma
  // captures the box (border/bg/chevron) but no text. Replace each with a <div> that copies
  // the box's computed styling AND holds the displayed text as a real text node.
  // Button inputs (submit/reset/button, e.g. Rails `f.submit`) are the same case: their label
  // lives in the `value` attribute, so they'd otherwise capture as a box with no text.
  const renderTextFields = () => {
    const SKIP = ["checkbox", "radio", "hidden", "image", "file", "range", "color"];
    const BUTTON_TYPES = ["submit", "reset", "button"];
    document.querySelectorAll("select, textarea, input").forEach((el) => {
      if (!isRendered(el)) return;
      const tag = el.tagName.toLowerCase();
      const type = tag === "input" ? (el.type || "text").toLowerCase() : null;
      if (tag === "input" && SKIP.indexOf(type) !== -1) return;
      const isButton = BUTTON_TYPES.indexOf(type) !== -1;

      let text, placeholder = false;
      if (tag === "select") {
        const opt = el.options[el.selectedIndex];
        text = opt ? opt.text : "";
      } else if (el.value) {
        text = el.value;
      } else {
        text = el.placeholder || "";
        placeholder = true;
      }
      if (!text) return;

      const cs = window.getComputedStyle(el);
      const box = document.createElement("div");
      box.className = el.className;
      const s = box.style;
      [
        "boxSizing", "width", "height",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
        "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
        "borderTopStyle", "borderRightStyle", "borderBottomStyle", "borderLeftStyle",
        "borderTopColor", "borderRightColor", "borderBottomColor", "borderLeftColor",
        "borderTopLeftRadius", "borderTopRightRadius", "borderBottomRightRadius", "borderBottomLeftRadius",
        "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat",
        "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textAlign",
        "marginTop", "marginRight", "marginBottom", "marginLeft",
      ].forEach((p) => { s[p] = cs[p]; });
      s.display = "flex";
      s.alignItems = tag === "textarea" ? "flex-start" : "center";
      if (isButton) s.justifyContent = "center";
      s.overflow = "hidden";
      s.whiteSpace = tag === "textarea" ? "pre-wrap" : "nowrap";
      if (placeholder) {
        const pc = window.getComputedStyle(el, "::placeholder").color;
        s.color = (pc && pc !== "rgba(0, 0, 0, 0)") ? pc : "rgb(117, 117, 117)";
      } else {
        s.color = cs.color;
      }
      box.textContent = text;
      el.replaceWith(box);
    });
  };

  // --- Layer-tree enrichment (after capture) ---------------------------------

  // Enrich each layer from its DOM ref (kept via the vendored-bundle patch): CSS/BEM class
  // names, font-weight, opacity, gradients, border-image underlines, bg-icon markers, fixed
  // overlay markers, baked SVG colors. Then drop ref (unserializable).
  const enrich = (arr) => arr.forEach((l) => {
    const el = l.ref;
    const element = (el && el.nodeType === 1) ? el
                  : (el && el.nodeType === 3 && el.parentElement) ? el.parentElement
                  : null;
    if (element) {
      if (el.nodeType === 1) {
        const cls = (typeof el.className === "string") ? el.className.trim() : "";
        if (cls) l.name = cls;
        const bgi = window.getComputedStyle(el).backgroundImage;
        if (bgi && bgi.indexOf("linear-gradient") === 0 && bgi.indexOf("radial-gradient") === -1) {
          const g = parseLinearGradient(bgi);
          if (g) l.__gradient = g;
        }
        // Get rect early — needed for both percentage radius resolution and __pageRect.
        const _r = el.getBoundingClientRect();
        l.__pageRect = { x: Math.round(_r.left), y: Math.round(_r.top), w: Math.round(_r.width), h: Math.round(_r.height) };

        // Capture computed border-radius. getComputedStyle may return "50%" (with %) for
        // percentage radii — parseFloat("50%") = 50 regardless of element size, same wrong
        // value html-to-figma produces. Detect % and resolve against actual element dims.
        const cs = window.getComputedStyle(el);
        const minDim = Math.min(_r.width || 1, _r.height || 1);
        let hasPercentRadius = false;
        const resolveRadius = (str) => {
          const v = parseFloat(str) || 0;
          if (!v) return 0;
          if (str.indexOf("%") !== -1) { hasPercentRadius = true; return v / 100 * minDim; }
          return v;
        };
        const tl = resolveRadius(cs.borderTopLeftRadius);
        const tr = resolveRadius(cs.borderTopRightRadius);
        const br = resolveRadius(cs.borderBottomRightRadius);
        const bl = resolveRadius(cs.borderBottomLeftRadius);
        if (tl || tr || br || bl) {
          l.__computedRadius = { tl, tr, br, bl };
          if (hasPercentRadius) l.__pctRadius = true;
        }

        const bis = window.getComputedStyle(el).borderImageSource;
        if (bis && bis.indexOf("linear-gradient") !== -1) {
          const ug = parseLinearGradient(bis);
          const bw = parseFloat(window.getComputedStyle(el).borderBottomWidth) || 0;
          if (ug && bw > 0) l.__underline = { gradient: ug, h: bw };
        }
        const op = parseFloat(window.getComputedStyle(el).opacity);
        if (op >= 0 && op < 1) l.opacity = op;
        let pf = el, z = null, fixed = false;
        while (pf && pf.nodeType === 1) {
          const pcs = window.getComputedStyle(pf);
          if (pcs.position === "fixed") { fixed = true; const zz = parseInt(pcs.zIndex); if (!isNaN(zz)) z = Math.max(z == null ? -1 : z, zz); }
          pf = pf.parentElement;
        }
        if (fixed) { const r = el.getBoundingClientRect(); l.__fixed = { z: z == null ? 0 : z, x: r.left, y: r.top }; }
        if (bgi && bgi.indexOf("url(") !== -1) {
          const bsize = window.getComputedStyle(el).backgroundSize;
          const brepeat = window.getComputedStyle(el).backgroundRepeat;
          if (brepeat.indexOf("no-repeat") !== -1 && bsize && bsize.indexOf("%") === -1 &&
              bsize !== "cover" && bsize !== "contain" && bsize !== "auto" && bsize.indexOf("auto auto") === -1) {
            const sw = parseFloat(bsize);
            if (!isNaN(sw) && sw > 0) {
              const parts2 = bsize.split(" ");
              const sh = (parts2[1] && parts2[1] !== "auto") ? parseFloat(parts2[1]) : sw;
              const _pcs = window.getComputedStyle(el);
              l.__bgIcon = { w: sw, h: sh, px: _pcs.backgroundPositionX, py: _pcs.backgroundPositionY };
            }
          }
        }
      }
      // KNOWN LIMITATION: inline elements within a block (e.g. <strong> inside <p>, or Rails
      // _html i18n keys) produce multiple sibling TEXT nodes all positioned at x:0, y:0 of
      // their parent FRAME. html-to-figma has no inline-flow layout engine, so it can't
      // compute each run's actual x offset. The nodes stack on top of each other in Figma.
      // Fix would require merging sibling TEXT nodes into one, losing inline formatting.
      if (l.type === "TEXT") {
        if (!l.name) {
          const pcls = (typeof element.className === "string") ? element.className.trim() : "";
          if (pcls) l.name = pcls;
        }
        const fw = parseInt(window.getComputedStyle(element).fontWeight, 10);
        if (fw) l.fontWeight = fw;
        // Text nodes (nodeType 3) don't hit the __pageRect capture above (that's element-only).
        // Grab the real rendered rect via a Range so fixCoordinates can correct text that
        // html-to-figma mis-positions relative to its parent — e.g. a label inside a
        // margin:auto-centered button, which otherwise lands at the wrong relative x.
        if (!l.__pageRect) {
          let tr = null;
          try {
            if (el.nodeType === 3) { const rg = document.createRange(); rg.selectNodeContents(el); tr = rg.getBoundingClientRect(); }
            else { tr = element.getBoundingClientRect(); }
          } catch (e) { /* ignore */ }
          if (tr && (tr.width || tr.height)) {
            l.__pageRect = { x: Math.round(tr.left), y: Math.round(tr.top), w: Math.round(tr.width), h: Math.round(tr.height) };
          }
        }
      }
    }
    if (l.type === "SVG" && el && el.nodeName && el.nodeName.toLowerCase() === "svg") {
      const clone = el.cloneNode(true);
      const orig = [el].concat(Array.prototype.slice.call(el.querySelectorAll("*")));
      const cl = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll("*")));
      for (let i = 0; i < orig.length && i < cl.length; i++) {
        const cs = window.getComputedStyle(orig[i]);
        if (cs.fill) cl[i].setAttribute("fill", cs.fill);
        if (cs.stroke && cs.stroke !== "none") cl[i].setAttribute("stroke", cs.stroke);
        if (cs.strokeWidth && cs.strokeWidth !== "0px") cl[i].setAttribute("stroke-width", cs.strokeWidth);
      }
      l.svg = clone.outerHTML;
    }
    delete l.ref;
    if (Array.isArray(l.children)) enrich(l.children);
  });

  // The body's background isn't captured; put it on the root frame, behind everything.
  const setRootBg = (layers) => {
    const bg = cssColorToFill(window.getComputedStyle(document.body).backgroundColor) ||
               cssColorToFill(window.getComputedStyle(document.documentElement).backgroundColor);
    if (bg && layers[0] && (!Array.isArray(layers[0].fills) || !layers[0].fills.length)) {
      layers[0].fills = [bg];
    }
  };

  // htmlToFigma (useFrames) backs each styled element with a full-cover RECTANGLE (unnamed =
  // bg color/border, named "IMAGE" = background-image). Merge it onto the FRAME, then drop it.
  const mergeBackings = (arr) => arr.forEach((node) => {
    if (node.type === "FRAME" && Array.isArray(node.children)) {
      const w = node.width || 0, h = node.height || 0;
      let merged = false;
      node.children = node.children.filter((c) => {
        const isBacking = !merged && c.type === "RECTANGLE" && (!c.name || c.name === "IMAGE") &&
          Math.abs(c.x || 0) <= 1 && Math.abs(c.y || 0) <= 1 &&
          Math.abs((c.width || 0) - w) <= 1 && Math.abs((c.height || 0) - h) <= 1;
        if (!isBacking) return true;
        merged = true;
        if (c.fills) node.fills = c.fills;
        if (c.strokes) { node.strokes = c.strokes; if (c.strokeWeight != null) node.strokeWeight = c.strokeWeight; }
        ["topLeftRadius", "topRightRadius", "bottomLeftRadius", "bottomRightRadius"].forEach((k) => { if (c[k] != null) node[k] = c[k]; });
        if (c.effects) node.effects = c.effects;
        return false;
      });
    }
    if (Array.isArray(node.children)) mergeBackings(node.children);
  });

  // html-to-figma sometimes misreads an element's bounding rect — in particular, display:inline
  // elements with all:unset get coordinates of (0,0,pageW,pageH) instead of their real size, and
  // it drops the margin:auto centering offset on block containers (so their children, kept at
  // their true centered coords, overflow the mis-placed parent). We stored the real
  // getBoundingClientRect() in l.__pageRect during enrich() and use it here to correct any node
  // whose declared position differs significantly from the ground truth: POSITION is corrected
  // for every node type (a centered button label sits at the wrong relative x otherwise), SIZE
  // only for FRAMEs — a leaf's own width/height drives text wrapping / image scaling, which
  // html-to-figma gets right. When a parent FRAME is corrected, its direct children's coords are
  // shifted by the inverse delta so children WITHOUT a __pageRect stay put; children WITH one are
  // then re-derived from ground truth in the recursion.
  const fixCoordinates = (arr, parentPageRect) => {
    arr.forEach((l) => {
      const pr = l.__pageRect;
      let deltaX = 0, deltaY = 0;
      if (pr && parentPageRect && (pr.w > 0 || pr.h > 0)) {
        const isFrame = l.type === "FRAME";
        // A leaf that shares its DOM ref with a sibling carries that element's __pageRect, which
        // is NOT its own box: html-to-figma backs a bordered element with a thin RECTANGLE (the
        // border, placed at its true sub-position, e.g. a border-bottom divider) AND a FRAME for
        // the content — both point at the same element and get the same __pageRect. Repositioning
        // the thin border to that full-element rect stacks it at the element's top. Trust
        // __pageRect for a leaf only when it actually describes that leaf (size roughly matches).
        // TEXT always trusts __pageRect (its own rect, from a Range in enrich); the size gate is
        // only for non-text leaves (RECTANGLE/SVG), where a size mismatch flags a shared-ref
        // border backing whose __pageRect is the full element, not the thin sub-rect.
        const tolW = Math.max(4, pr.w * 0.2), tolH = Math.max(4, pr.h * 0.2);
        const ownRect = isFrame || l.type === "TEXT" ||
          (Math.abs((l.width || 0) - pr.w) <= tolW && Math.abs((l.height || 0) - pr.h) <= tolH);
        const expX = pr.x - parentPageRect.x;
        const expY = pr.y - parentPageRect.y;
        const offPos = Math.abs((l.x || 0) - expX) > 20 || Math.abs((l.y || 0) - expY) > 20;
        const offSize = isFrame && (Math.abs((l.width || 0) - pr.w) > 20 || Math.abs((l.height || 0) - pr.h) > 20);
        if (ownRect && (offPos || offSize)) {
          deltaX = expX - (l.x || 0);
          deltaY = expY - (l.y || 0);
          l.x = expX; l.y = expY;
          if (isFrame) { l.width = pr.w; l.height = pr.h; }
        }
      }
      const myRect = (pr && l.type === "FRAME") ? pr : parentPageRect;
      delete l.__pageRect;
      if (Array.isArray(l.children)) {
        if (deltaX !== 0 || deltaY !== 0) {
          l.children.forEach((c) => { c.x = (c.x || 0) - deltaX; c.y = (c.y || 0) - deltaY; });
        }
        fixCoordinates(l.children, myRect);
      }
    });
  };

  // Apply computed border-radius values (captured in enrich()) after mergeBackings so the
  // ground-truth pixel values override whatever html-to-figma wrote on the backing RECTANGLE
  // (which fails to resolve % radii like border-radius:50%).
  const applyComputedRadius = (arr) => arr.forEach((l) => {
    if (l.__computedRadius) {
      const { tl, tr, br, bl } = l.__computedRadius;
      const pct = l.__pctRadius;
      l.topLeftRadius = pct && tl ? 999 : tl;
      l.topRightRadius = pct && tr ? 999 : tr;
      l.bottomRightRadius = pct && br ? 999 : br;
      l.bottomLeftRadius = pct && bl ? 999 : bl;
      delete l.__computedRadius;
      delete l.__pctRadius;
    }
    if (Array.isArray(l.children)) applyComputedRadius(l.children);
  });

  // Gradients are detected during enrich() but applied after mergeBackings (which would
  // otherwise overwrite the fill with the merged solid backing).
  const applyGradients = (arr) => arr.forEach((l) => {
    if (l.__gradient) { l.fills = [l.__gradient]; delete l.__gradient; }
    if (Array.isArray(l.children)) applyGradients(l.children);
  });

  // border-image underline: html-to-figma emits TWO sibling nodes for the same element —
  // a thin RECTANGLE (the rendered border-bottom box, solid color) and a FRAME (the content).
  // Both share the same DOM ref so enrich() sets __underline on both.
  // Pass 1: replace the solid fill of border RECTANGLEs (height ≈ borderWidth) with the gradient.
  // Pass 2: for FRAME/other nodes, add a child gradient rect only if no sibling border
  //         RECTANGLE already handles it (avoids the duplicate black + gradient underline).
  const applyUnderlines = (arr) => {
    const borderRectNames = new Set();
    arr.forEach((l) => {
      if (l.__underline && l.type === "RECTANGLE" &&
          typeof l.height === "number" && l.height <= l.__underline.h + 1) {
        if (l.name) borderRectNames.add(l.name);
        l.fills = [l.__underline.gradient];
        l.name = "active-underline";
        delete l.__underline;
      }
    });
    arr.forEach((l) => {
      if (l.__underline && typeof l.width === "number" && typeof l.height === "number") {
        if (!borderRectNames.has(l.name)) {
          (l.children = l.children || []).push({
            type: "RECTANGLE", name: "active-underline",
            x: 0, y: Math.max(0, l.height - l.__underline.h),
            width: l.width, height: l.__underline.h,
            fills: [l.__underline.gradient],
          });
        }
        delete l.strokes;
        delete l.strokeWeight;
        delete l.__underline;
      }
      if (Array.isArray(l.children)) applyUnderlines(l.children);
    });
  };

  // Resolve a computed background-position-x/y value into a pixel offset for the icon's
  // top-left corner. `range` is (container_size - icon_size). Handles keywords (center/left/
  // right/…), percentages, pixels, "edge offset" forms ("right 14px"), calc() expressions
  // ("calc(100% - 12px)"), and multiple background layers (first layer = topmost icon).
  const resolveBgTerms = (expr, range) => {
    let total = 0;
    expr.replace(/\s+/g, "").replace(/([+-])/g, " $1").trim().split(/\s+/).forEach((t) => {
      if (!t) return;
      if (t.charAt(t.length - 1) === "%") total += range * (parseFloat(t) || 0) / 100;
      else total += parseFloat(t) || 0;
    });
    return total;
  };
  const resolveBgAxis = (raw, range) => {
    if (!raw) return range / 2;
    const str = String(raw).split(",")[0].trim().toLowerCase();
    if (str === "center") return range / 2;
    if (str === "left" || str === "top") return 0;
    if (str === "right" || str === "bottom") return range;
    const edge = str.match(/^(left|right|top|bottom)\s+(.+)$/);
    if (edge) {
      const off = resolveBgTerms(edge[2], range);
      return (edge[1] === "right" || edge[1] === "bottom") ? range - off : off;
    }
    return resolveBgTerms(str.replace(/^calc\((.*)\)$/, "$1"), range);
  };

  // A background-image rendered at a fixed small size (icon) becomes a positioned child instead
  // of a stretched fill. Converts the leaf RECTANGLE into a FRAME + icon child, honouring the
  // element's computed background-position (falls back to centered).
  const applyBgIcons = (arr) => arr.forEach((l) => {
    if (l.__bgIcon && Array.isArray(l.fills) && typeof l.width === "number" && typeof l.height === "number") {
      const imgFill = l.fills.find((f) => f && f.type === "IMAGE");
      if (imgFill) {
        const w = Math.min(l.__bgIcon.w, l.width), h = Math.min(l.__bgIcon.h, l.height);
        const icon = { type: "RECTANGLE", name: "bg-icon",
          x: resolveBgAxis(l.__bgIcon.px, l.width - w), y: resolveBgAxis(l.__bgIcon.py, l.height - h),
          width: w, height: h, fills: [imgFill] };
        l.type = "FRAME";
        l.fills = l.fills.filter((f) => !(f && f.type === "IMAGE"));
        l.children = (l.children || []).concat([icon]);
      }
    }
    delete l.__bgIcon;
    if (Array.isArray(l.children)) applyBgIcons(l.children);
  });

  // Lift fixed-positioned overlay subtrees (modal, backdrop) to the front of the root so Figma
  // paints them on top. Reverse-append in the plugin means front == lowest index, so we unshift
  // in ascending z (highest z ends up first = frontmost).
  const liftOverlays = (root) => {
    if (!root || !Array.isArray(root.children)) return;
    const collected = [];
    const walk = (arr, insideFixed) => {
      for (let i = arr.length - 1; i >= 0; i--) {
        const l = arr[i];
        if (l.__fixed && !insideFixed) {
          l.x = l.__fixed.x; l.y = l.__fixed.y;
          collected.push({ node: l, z: l.__fixed.z });
          delete l.__fixed;
          arr.splice(i, 1);
        } else if (Array.isArray(l.children)) {
          walk(l.children, insideFixed || !!l.__fixed);
        }
      }
    };
    walk(root.children, false);
    collected.sort((a, b) => a.z - b.z);
    collected.forEach((o) => root.children.unshift(o.node));
  };

  // IMAGE fills reference URLs on the (still-alive) test server. Re-encode each to PNG via
  // canvas (figma.createImage rejects WebP/SVG/some JPEGs; >4096px too) and inline as base64.
  const inlineImages = async (layers) => {
    const fills = [];
    const collect = (arr) => arr.forEach((n) => {
      (n.fills || []).forEach((f) => { if (f && f.type === "IMAGE" && f.url) fills.push(f); });
      collect(n.children || []);
    });
    collect(layers);
    const MAX_DIM = 2048;
    const rasterize = (url) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        let w = img.naturalWidth || img.width || 64;
        let h = img.naturalHeight || img.height || 64;
        const k = Math.min(1, MAX_DIM / Math.max(w, h));
        w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        try {
          canvas.getContext("2d").drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL("image/png").split(",")[1] || "");
        } catch (e) { resolve(""); }
      };
      img.onerror = () => resolve("");
      img.src = url;
    });
    const cache = {};
    await Promise.all(fills.map(async (f) => {
      if (!(f.url in cache)) cache[f.url] = await rasterize(f.url);
      if (cache[f.url]) f.imageBase64 = cache[f.url];
    }));
  };

  // --- Orchestrator ----------------------------------------------------------
  window.__figmaCapture = async (htmlToFigma, selector) => {
    expandScrollContainers();
    hideVisuallyHidden();
    await rasterizeFontAwesome();
    renderFormControls();
    renderTextFields();
    const layers = await htmlToFigma(selector, true);
    setRootBg(layers);
    enrich(layers);
    mergeBackings(layers);
    fixCoordinates(layers, null);
    applyComputedRadius(layers);
    applyGradients(layers);
    applyUnderlines(layers);
    applyBgIcons(layers);
    liftOverlays(layers[0]);
    await inlineImages(layers);
    return JSON.stringify({ layers: layers });
  };
})();
