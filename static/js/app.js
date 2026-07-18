"use strict";

(() => {
  const Parser = window.MODEVIEWER_PARSER;
  const Viewer = window.MODEVIEWER_VIEWER;

  const state = {
    data: null,              // parsed result from Parser
    selectedAtoms: new Set(),
    selectedMode: null,      // mode number, or null
    sortKey: "mode",
    sortDir: "asc",
    atomSearch: "",
    vibAmplitude: 0.5,
    contribThreshold: 0.10,  // fraction (0-0.5) - which atoms count as "main atoms"
    autoAnimate: true,      // whether selecting a mode starts its vibration right away
    oneBasedIndex: true      // display atoms as C1, C2, ... instead of C0, C1, ...
  };

  const el = {
    dropzone: document.getElementById("dropzone"),
    fileInput: document.getElementById("file-input"),
    fileMeta: document.getElementById("file-meta"),
    viewerPanel: document.getElementById("viewer-panel"),
    tableBody: document.getElementById("mode-table-body"),
    tableHead: document.getElementById("mode-table-head"),
    selectionChips: document.getElementById("selection-chips"),
    selectionRow: document.getElementById("selection-row"),
    clearSelectionBtn: document.getElementById("clear-selection"),
    resetViewBtn: document.getElementById("reset-view"),
    bondTolerance: document.getElementById("bond-tolerance"),
    bondToleranceLabel: document.getElementById("bond-tolerance-label"),
    autoAnimateToggle: document.getElementById("auto-animate-toggle"),
    vibAmplitude: document.getElementById("vib-amplitude"),
    vibAmplitudeLabel: document.getElementById("vib-amplitude-label"),
    contribThreshold: document.getElementById("contrib-threshold"),
    contribThresholdLabel: document.getElementById("contrib-threshold-label"),
    oneBasedToggle: document.getElementById("one-based-toggle"),
    atomSearch: document.getElementById("atom-search"),
    atomListBody: document.getElementById("atom-list-body"),
    spectrumEl: document.getElementById("spectrum"),
    emptyState: document.getElementById("empty-state"),
    appMain: document.getElementById("app-main")
  };

  let viewerInitialized = false;

  function init() {
    Viewer.setAtomClickCallback((atomIndex) => {
      toggleAtomSelection(atomIndex);
    });

    el.fileInput.addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) loadFile(file);
    });

    el.dropzone.addEventListener("click", () => el.fileInput.click());

    ["dragenter", "dragover"].forEach((evt) => {
      el.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        el.dropzone.classList.add("dragover");
      });
    });

    ["dragleave", "drop"].forEach((evt) => {
      el.dropzone.addEventListener(evt, (e) => {
        e.preventDefault();
        el.dropzone.classList.remove("dragover");
      });
    });

    el.dropzone.addEventListener("drop", (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadFile(file);
    });

    el.clearSelectionBtn.addEventListener("click", () => {
      state.selectedAtoms.clear();
      renderAll();
    });

    el.resetViewBtn.addEventListener("click", () => Viewer.resetView());

    el.bondTolerance.addEventListener("input", () => {
      const pct = parseInt(el.bondTolerance.value, 10);
      el.bondToleranceLabel.textContent = `${pct}%`;
      Viewer.setBondTolerance(pct);

      // Same reasoning as contribThreshold: connectivity is baked into
      // the 3Dmol model once per render(), so a running vibration keeps
      // using the bonds it started with until the next static render.
      if (!Viewer.isVibrating()) render3D();
    });

    el.atomSearch.addEventListener("input", () => {
      state.atomSearch = el.atomSearch.value.trim().toLowerCase();
      renderAtomList();
    });

    el.autoAnimateToggle.addEventListener("change", () => setAutoAnimate(el.autoAnimateToggle.checked));

    el.oneBasedToggle.addEventListener("change", () => {
      state.oneBasedIndex = el.oneBasedToggle.checked;
      renderAll();
    });

    el.contribThreshold.addEventListener("input", () => {
      state.contribThreshold = parseInt(el.contribThreshold.value, 10) / 100;
      el.contribThresholdLabel.textContent = `${el.contribThreshold.value}%`;

      // The threshold only changes which atoms are labelled "main
      // atoms" (table) and get a halo (static view) - it never changes
      // which atoms actually move in the animation, so a running
      // vibration is left untouched.
      renderTable();
      if (!Viewer.isVibrating()) render3D();
    });

    el.vibAmplitude.addEventListener("input", () => {
      state.vibAmplitude = parseFloat(el.vibAmplitude.value);
      el.vibAmplitudeLabel.textContent = `${state.vibAmplitude.toFixed(1)}\u00d7`;

      // Live-update an already-running animation instead of requiring
      // the user to stop/restart it for the new amplitude to apply.
      if (Viewer.isVibrating()) {
        const row = getSelectedModeRow();
        if (row && row.atomContributions) {
          Viewer.startVibration(row.atomContributions, state.vibAmplitude);
        }
      }
    });

    window.addEventListener("resize", () => {
      Viewer.resize();
      if (state.data && window.Plotly) {
        Plotly.Plots.resize(el.spectrumEl);
      }
    });

    // CSS custom properties already update live with the OS light/dark
    // switch (that's just the prefers-color-scheme media query), but two
    // things were baked in at render time and don't follow along on
    // their own: the 3Dmol canvas's background color (set once, in
    // Viewer.init()) and the Plotly layout colors (computed once per
    // renderSpectrum() call). Re-push both whenever the preference flips.
    const darkModeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    darkModeQuery.addEventListener("change", () => {
      if (viewerInitialized) Viewer.updateBackgroundColor();
      renderAll();
    });
  }

  function loadFile(file) {
    const reader = new FileReader();

    reader.onload = () => {
      try {
        const text = reader.result;
        const data = Parser.parseOrcaOutput(text, file.name);

        if (!data.geometry || data.geometry.length === 0) {
          throw new Error(
            "No atomic geometry found (missing CARTESIAN COORDINATES / Standard orientation)."
          );
        }

        state.data = data;
        state.selectedAtoms = new Set();
        state.selectedMode = null;
        state.atomSearch = "";
        el.atomSearch.value = "";

        el.emptyState.style.display = "none";
        el.appMain.style.display = "grid";

        el.fileMeta.textContent =
          `${file.name} — ${data.program}` +
          (data.orcaVersion ? ` ${data.orcaVersion}` : "") +
          ` — ${data.stats.modesParsed} modes`;

        if (!viewerInitialized) {
          Viewer.init("viewer-3d");
          viewerInitialized = true;
        }

        Viewer.load(data.geometry);
        renderAll();

        // The viewer panel was "display: none" until a few lines above,
        // so the container 3Dmol measured when creating its canvas may
        // not yet be the final, settled grid-layout size (e.g. once the
        // mode table below has finished populating). If that happens,
        // 3Dmol's canvas ends up sized for the pre-layout box and gets
        // CSS-stretched to fit the real one, making the structure look
        // larger than the panel. A resize on the next settled frame
        // re-measures the container and fixes the mismatch.
        requestAnimationFrame(() => {
          requestAnimationFrame(() => Viewer.resize());
        });
      } catch (err) {
        alert("Error reading file:\n" + err.message);
      }
    };

    reader.readAsText(file);
  }

  function toggleAtomSelection(atomIndex) {
    if (state.selectedAtoms.has(atomIndex)) {
      state.selectedAtoms.delete(atomIndex);
    } else {
      state.selectedAtoms.add(atomIndex);
    }

    // Manually picking atoms (from the list or by clicking in 3D) is a
    // separate workflow from inspecting a mode's normal-mode motion.
    // Keeping both halos on screen at once was confusing, so picking
    // an atom clears the current mode selection (and any running
    // animation) rather than layering on top of it.
    state.selectedMode = null;

    renderAll();
    scrollAtomListToAtom(atomIndex);
  }

  // Brings the atom's row in the atom list into view - mainly for
  // clicks originating in the 3D viewer, so the user can see which
  // atom lit up without hunting through the list. Only scrolls when
  // the atom ended up selected (not on deselect-clicks), and quietly
  // does nothing if the row isn't currently rendered (e.g. filtered
  // out by the search box). Same manual scroll approach as
  // scrollTableToSelectedMode() and for the same reason: the sticky
  // <thead> can visually cover a row that scrollIntoView would still
  // consider "visible".
  function scrollAtomListToAtom(atomIndex) {
    if (!state.selectedAtoms.has(atomIndex)) return;

    const tr = el.atomListBody.querySelector(`tr[data-atom-index="${atomIndex}"]`);
    if (!tr) return;

    const container = tr.closest(".atom-list-wrap");
    if (!container) return;

    const theadEl = container.querySelector("thead");
    const headerHeight = theadEl ? theadEl.getBoundingClientRect().height : 0;
    const containerRect = container.getBoundingClientRect();
    const rowRect = tr.getBoundingClientRect();

    const visibleTop = containerRect.top + headerHeight;
    const visibleBottom = containerRect.bottom;

    let delta = 0;
    if (rowRect.top < visibleTop) {
      delta = rowRect.top - visibleTop;
    } else if (rowRect.bottom > visibleBottom) {
      delta = rowRect.bottom - visibleBottom;
    }

    if (delta !== 0) {
      container.scrollBy({ top: delta, behavior: "smooth" });
    }
  }

  function selectMode(modeNumber) {
    state.selectedMode = state.selectedMode === modeNumber ? null : modeNumber;
    renderAll(); // static baseline render (table, spectrum, halo view)

    if (state.selectedMode !== null && state.autoAnimate) {
      const row = getSelectedModeRow();
      if (row && row.atomContributions) {
        Viewer.startVibration(row.atomContributions, state.vibAmplitude);
      }
    }

    updateVibrationControls();
    scrollTableToSelectedMode();
  }

  // Brings the selected mode's row into view - mainly for clicks
  // originating in the spectrum, so the user can see which row lit up
  // without hunting through the table. Written by hand instead of
  // relying on scrollIntoView(), because the sticky <thead> visually
  // covers the top of the scroll container: a row can sit right under
  // it and still count as "visible" to the browser, so scrollIntoView's
  // "nearest" would skip scrolling even though the row is hidden.
  function scrollTableToSelectedMode() {
    if (state.selectedMode === null) return;

    const tr = el.tableBody.querySelector("tr.selected");
    if (!tr) return;

    const container = tr.closest(".table-scroll");
    if (!container) return;

    const headerHeight = el.tableHead ? el.tableHead.getBoundingClientRect().height : 0;
    const containerRect = container.getBoundingClientRect();
    const rowRect = tr.getBoundingClientRect();

    const visibleTop = containerRect.top + headerHeight;
    const visibleBottom = containerRect.bottom;

    let delta = 0;
    if (rowRect.top < visibleTop) {
      delta = rowRect.top - visibleTop;
    } else if (rowRect.bottom > visibleBottom) {
      delta = rowRect.bottom - visibleBottom;
    }

    if (delta !== 0) {
      container.scrollBy({ top: delta, behavior: "smooth" });
    }
  }

  function getSelectedModeRow() {
    if (!state.data || state.selectedMode === null) return null;
    return state.data.rows.find((r) => r.mode === state.selectedMode) || null;
  }

  // Persistent on/off switch: while on, every mode selection (table
  // row or spectrum stick click, both funnel through selectMode())
  // starts that mode's vibration immediately. While off, selecting a
  // mode only shows the static contribution halo - handy for reading
  // off which atoms are involved without the motion blur.
  function setAutoAnimate(enabled) {
    state.autoAnimate = enabled;

    if (!enabled) {
      if (Viewer.isVibrating()) {
        Viewer.stopVibration();
        render3D();
      }
    } else if (state.selectedMode !== null) {
      const row = getSelectedModeRow();
      if (row && row.atomContributions) {
        Viewer.startVibration(row.atomContributions, state.vibAmplitude);
      }
    }
  }

  function updateVibrationControls() {
    el.vibAmplitude.disabled = state.selectedMode === null;
  }

  function displayIndex(atomIndex) {
    return state.oneBasedIndex ? atomIndex + 1 : atomIndex;
  }

  function atomLabel(atomIndex) {
    const atom = state.data.geometry[atomIndex];
    return atom ? `${atom.element}${displayIndex(atom.index)}` : `#${atomIndex}`;
  }

  function contributionMapForMode(row) {
    const map = new Map();
    if (!row || !row.atomContributions) return map;
    for (const c of row.atomContributions) {
      // atomContributions use 1-based atomNumber for ORCA, 1-based
      // atomIndex for Gaussian - both are (index + 1) by construction.
      map.set(c.atomNumber - 1, c.fraction);
    }
    return map;
  }

  function selectionFraction(row) {
    if (state.selectedAtoms.size === 0 || !row.atomContributions) return null;
    let sum = 0;
    for (const c of row.atomContributions) {
      if (state.selectedAtoms.has(c.atomNumber - 1)) sum += c.fraction;
    }
    return sum;
  }

  function renderAll() {
    renderSelectionChips();
    render3D();
    renderTable();
    renderSpectrum();
    renderAtomList();
    updateVibrationControls();
  }

  function renderSelectionChips() {
    el.selectionChips.innerHTML = "";

    if (state.selectedAtoms.size === 0) {
      el.selectionRow.style.display = "none";
      return;
    }

    el.selectionRow.style.display = "";

    let i = 0;
    for (const atomIndex of state.selectedAtoms) {
      i++;
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.innerHTML =
        `<span class="chip-index">${i}</span>${atomLabel(atomIndex)}` +
        `<span class="chip-remove" data-idx="${atomIndex}">\u00d7</span>`;
      el.selectionChips.appendChild(chip);
    }

    el.selectionChips.querySelectorAll(".chip-remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = parseInt(btn.dataset.idx, 10);
        state.selectedAtoms.delete(idx);
        renderAll();
      });
    });
  }

  function render3D() {
    let contributions = null;

    if (state.selectedMode !== null) {
      const row = state.data.rows.find((r) => r.mode === state.selectedMode);
      contributions = contributionMapForMode(row);
    }

    Viewer.render({
      contributions,
      selectedAtoms: state.selectedAtoms,
      contribThreshold: state.contribThreshold
    });
  }

  function renderAtomList() {
    el.atomListBody.innerHTML = "";
    if (!state.data) return;

    const query = state.atomSearch;
    const rows = state.data.geometry.filter((atom) => {
      if (!query) return true;
      const label = `${atom.element}${displayIndex(atom.index)}`.toLowerCase();
      return label.includes(query) || atom.element.toLowerCase().includes(query);
    });

    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "atom-list-empty";
      td.textContent = "No matching atoms.";
      tr.appendChild(td);
      el.atomListBody.appendChild(tr);
      return;
    }

    for (const atom of rows) {
      const tr = document.createElement("tr");
      tr.dataset.atomIndex = atom.index;

      if (state.selectedAtoms.has(atom.index)) tr.classList.add("selected");

      tr.innerHTML =
        `<td>${atom.element}${displayIndex(atom.index)}</td>` +
        `<td class="el-cell">${atom.element}</td>` +
        `<td>${atom.x.toFixed(4)}</td>` +
        `<td>${atom.y.toFixed(4)}</td>` +
        `<td>${atom.z.toFixed(4)}</td>`;

      tr.addEventListener("click", () => toggleAtomSelection(atom.index));
      el.atomListBody.appendChild(tr);
    }
  }

  const COLUMNS = [
    { key: "mode", label: "Mode" },
    { key: "frequency", label: "\u03bd / cm\u207b\u00b9" },
    { key: "intensity", label: "Intensity" },
    { key: "symmetry", label: "Sym." },
    { key: "topAtom", label: "Main atom(s)" },
    { key: "selection", label: "Selected %" }
  ];

  function renderTableHead() {
    el.tableHead.innerHTML = "";
    const tr = document.createElement("tr");

    for (const col of COLUMNS) {
      const th = document.createElement("th");
      th.textContent = col.label;
      th.classList.add("sortable");

      if (state.sortKey === col.key) {
        th.classList.add(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
      }

      th.addEventListener("click", () => {
        if (state.sortKey === col.key) {
          state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
        } else {
          state.sortKey = col.key;
          state.sortDir = col.key === "mode" ? "asc" : "desc";
        }
        renderTable();
      });

      tr.appendChild(th);
    }

    el.tableHead.appendChild(tr);
  }

  function sortValue(row, key) {
    switch (key) {
      case "mode": return row.mode;
      case "frequency": return row.frequency;
      case "intensity": return row.intensity;
      case "symmetry": return row.symmetry || "";
      case "topAtom":
        return row.atomContributions && row.atomContributions.length
          ? row.atomContributions[0].fraction
          : -1;
      case "selection":
        return selectionFraction(row) || 0;
      default: return 0;
    }
  }

  // Lists every atom whose contribution clears state.contribThreshold
  // (always showing at least the single strongest atom, even if it
  // doesn't clear the threshold), capped at MAX_SHOWN to keep the
  // table cell readable.
  const MAX_SHOWN_ATOMS = 5;

  function topContribLabel(row) {
    if (!row.atomContributions || row.atomContributions.length === 0) return "\u2013";

    const thresholdPct = Math.round(state.contribThreshold * 100);
    const strong = row.atomContributions.filter((c) => Math.round(c.fraction * 100) >= thresholdPct);
    const list = strong.length > 0 ? strong : row.atomContributions.slice(0, 1);
    const shown = list.slice(0, MAX_SHOWN_ATOMS);

    const label = shown
      .map((c) => `${c.element}${displayIndex(c.atomNumber - 1)} (${(c.fraction * 100).toFixed(0)}%)`)
      .join(", ");

    const extra = list.length > shown.length ? ` +${list.length - shown.length}` : "";
    return label + extra;
  }

  function renderTable() {
    renderTableHead();
    el.tableBody.innerHTML = "";

    if (!state.data) return;

    const rows = state.data.rows.slice().sort((a, b) => {
      const va = sortValue(a, state.sortKey);
      const vb = sortValue(b, state.sortKey);
      if (va < vb) return state.sortDir === "asc" ? -1 : 1;
      if (va > vb) return state.sortDir === "asc" ? 1 : -1;
      return 0;
    });

    for (const row of rows) {
      const tr = document.createElement("tr");
      tr.classList.add("mode-row");

      if (state.selectedMode === row.mode) tr.classList.add("selected");

      const selFrac = selectionFraction(row);
      if (selFrac !== null && selFrac > 0.02) tr.classList.add("involves-selection");

      const cells = [
        row.mode,
        row.frequency.toFixed(1),
        row.intensity.toFixed(2),
        row.symmetry || "\u2013",
        topContribLabel(row),
        selFrac !== null ? `${(selFrac * 100).toFixed(0)}%` : "\u2013"
      ];

      for (const val of cells) {
        const td = document.createElement("td");
        td.textContent = val;
        tr.appendChild(td);
      }

      tr.addEventListener("click", () => selectMode(row.mode));
      el.tableBody.appendChild(tr);
    }
  }

  function renderSpectrum() {
    if (!state.data) return;

    const rows = state.data.rows;
    const colors = rows.map((r) =>
      state.selectedMode === r.mode ? "#ff9d2e" : "#5fa8d3"
    );

    const x = [];
    const y = [];
    const selX = [];
    const selY = [];

    for (const r of rows) {
      const target = state.selectedMode === r.mode ? [selX, selY] : [x, y];
      target[0].push(r.frequency, r.frequency, null);
      target[1].push(0, r.intensity, null);
    }

    const trace = {
      x: rows.map((r) => r.frequency),
      y: rows.map((r) => r.intensity),
      mode: "markers",
      type: "scatter",
      marker: { size: 7, color: colors },
      hovertemplate: "Mode %{customdata}<br>%{x:.1f} cm\u207b\u00b9<extra></extra>",
      customdata: rows.map((r) => r.mode)
    };

    const stems = {
      x, y, mode: "lines", type: "scatter",
      line: { color: "#5fa8d3", width: 1.5 },
      hoverinfo: "skip",
      showlegend: false
    };

    // The selected mode's stick as its own trace, drawn on top, so the
    // whole line is highlighted - not just the marker at its tip.
    const selectedStem = {
      x: selX, y: selY, mode: "lines", type: "scatter",
      line: { color: "#ff9d2e", width: 2.5 },
      hoverinfo: "skip",
      showlegend: false
    };

    const css = getComputedStyle(document.documentElement);
    const textColor = css.getPropertyValue("--text").trim();
    const mutedColor = css.getPropertyValue("--muted").trim();
    const borderColor = css.getPropertyValue("--border").trim();
    const panelColor = css.getPropertyValue("--panel").trim();
    const accentColor = css.getPropertyValue("--accent").trim();

    const layout = {
      margin: { l: 55, r: 20, t: 10, b: 55 },
      autosize: true,
      xaxis: {
        title: { text: "Wavenumber / cm\u207b\u00b9", standoff: 14 },
        autorange: "reversed",
        gridcolor: borderColor,
        zerolinecolor: borderColor,
        linecolor: borderColor,
        tickcolor: borderColor,
        tickfont: { color: mutedColor }
      },
      yaxis: {
        title: "Intensity",
        gridcolor: borderColor,
        zerolinecolor: borderColor,
        linecolor: borderColor,
        tickcolor: borderColor,
        tickfont: { color: mutedColor }
      },
      showlegend: false,
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: textColor },
      hoverlabel: {
        bgcolor: panelColor,
        bordercolor: borderColor,
        font: { color: textColor }
      },
      modebar: {
        bgcolor: "transparent",
        color: mutedColor,
        activecolor: accentColor
      }
    };

    const config = {
      displayModeBar: "hover", // only show the toolbar on hover, not permanently
      displaylogo: false,
      modeBarButtonsToRemove: [
        "select2d", "lasso2d", "autoScale2d",
        "hoverClosestCartesian", "hoverCompareCartesian", "toggleSpikelines"
      ],
      responsive: true
    };

    Plotly.react(el.spectrumEl, [stems, selectedStem, trace], layout, config);

    el.spectrumEl.removeAllListeners && el.spectrumEl.removeAllListeners("plotly_click");
    el.spectrumEl.on("plotly_click", (evt) => {
      const point = evt.points && evt.points[0];
      if (point && point.customdata !== undefined) {
        selectMode(point.customdata);
      }
    });
  }

  init();
})();
