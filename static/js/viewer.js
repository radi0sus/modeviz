"use strict";

/*
  3Dmol.js wrapper, adapted from advanced_xyz2tab's viewer.js.

  Highlighting strategy: instead of overwriting an atom's own sphere
  color (which frequently collides with CPK colors already in use,
  e.g. yellow S vs. a yellow "selected" tint), we draw translucent
  halo spheres on top of the untouched atom. The halo colors (magenta
  for mode contribution, cyan for explicit click-selection) do not
  appear anywhere in the CPK palette, so they stay readable regardless
  of which element sits underneath.
*/
window.MODEVIEWER_VIEWER = (() => {
  const Elements = window.MODEVIEWER_ELEMENTS;

  const CONTRIB_COLOR = "#ff3fa4"; // magenta — mode contribution weight
  const SELECT_COLOR = "#00d4ff";  // cyan — explicit atom click selection

  const VIBRATE_FRAMES = 10;
  const VIBRATE_INTERVAL_MS = 35;

  let viewer = null;
  let model = null;
  let atoms = [];
  let bonds = [];
  let bondTolerancePct = 8;
  let hasZoomed = false;
  let onAtomClick = null;
  let vibrating = false;

  // Snapshot of the atom list backing the currently displayed model
  // (kept for the click-handler index mapping and for vibration).
  let visibleAtoms = [];

  function init(containerId) {
    const el = document.getElementById(containerId);
    const css = getComputedStyle(document.documentElement);
    let bg = css.getPropertyValue("--viewer-bg").trim() || "#1a1a1a";

    if (bg.startsWith("#")) bg = "0x" + bg.slice(1);

    viewer = $3Dmol.createViewer(el, {
      backgroundColor: bg,
      antialias: true
    });
  }

  function setAtomClickCallback(fn) {
    onAtomClick = fn;
  }

  function load(geometryAtoms) {
    atoms = geometryAtoms || [];
    bonds = Elements.findBonds(atoms, bondTolerancePct);
    hasZoomed = false;
    render({});
  }

  // Called from the "Bond radius" slider. Recomputes connectivity at the
  // new tolerance; does NOT re-render by itself, so the caller can pass
  // through its own current contributions/selection state (see app.js
  // render3D(), same pattern as the contribution-threshold slider).
  function setBondTolerance(pct) {
    bondTolerancePct = pct;
    if (atoms.length > 0) {
      bonds = Elements.findBonds(atoms, bondTolerancePct);
    }
  }

  function resize() {
    if (!viewer) return;
    if (typeof viewer.resize === "function") viewer.resize();
    viewer.render();
  }

  /*
    contributions: Map<atomIndex, fraction> (0..1) for the currently
    selected mode, or null to just show plain element colors.
    selectedAtoms: Set<atomIndex> of atoms the user clicked on.
  */
  function render({
    contributions = null,
    selectedAtoms = new Set(),
    contribThreshold = 0.02
  } = {}) {
    if (!viewer || atoms.length === 0) return;

    // Any full static rebuild (new file, mode change, selection change)
    // implicitly ends an in-progress vibration — simpler and more
    // predictable than trying to keep an animating model in sync with
    // unrelated state changes.
    stopVibration();

    viewer.removeAllModels();
    viewer.removeAllShapes();
    viewer.removeAllLabels();

    visibleAtoms = atoms;
    const visibleIdx = new Set(visibleAtoms.map((a) => a.index));

    const visibleBonds = bonds;

    const xyzLines = [visibleAtoms.length.toString(), "mode-viewer"];
    for (const a of visibleAtoms) {
      xyzLines.push(`${a.element} ${a.x} ${a.y} ${a.z}`);
    }

    model = viewer.addModel(xyzLines.join("\n"), "xyz");

    // 3Dmol auto-perceives bonds on addModel using its own covalent-radius
    // table/tolerance, which does not match Elements.findBonds() (chem.js).
    // That mismatch is invisible in the static view (bonds are drawn
    // manually below, ignoring the model's own connectivity), but becomes
    // visible during vibration, where startVibration() switches to
    // 3Dmol's native "stick" style — which reads bonds directly off the
    // model. Overwriting the model's connectivity here with our own bonds
    // keeps both rendering paths consistent (e.g. avoids a borderline-
    // distance Cu–N nitrile "bond" appearing only while animating).
    const modelAtomsForBonds = model.selectedAtoms({});
    modelAtomsForBonds.forEach((a) => {
      a.bonds = [];
      a.bondOrder = [];
    });
    for (const bond of bonds) {
      const ai = modelAtomsForBonds[bond.i];
      const aj = modelAtomsForBonds[bond.j];
      if (!ai || !aj) continue;
      ai.bonds.push(bond.j);
      ai.bondOrder.push(1);
      aj.bonds.push(bond.i);
      aj.bondOrder.push(1);
    }

    const elements = [...new Set(visibleAtoms.map((a) => a.element))];
    for (const el of elements) {
      model.setStyle({ elem: el }, { sphere: { radius: 0.24, color: Elements.getColor(el) } });
    }

    // Mode-contribution halo: translucent overlay, scaled by fraction.
    if (contributions) {
      for (const [atomIndex, fraction] of contributions.entries()) {
        // Compare on the same rounded percentage that's shown in the
        // table (toFixed(0)), not the raw fraction - otherwise an atom
        // displayed as e.g. "10%" (actually 9.77%, rounded up) could
        // silently fail a 10% threshold and never get highlighted,
        // which looks like a bug from the user's side.
        const fractionPct = Math.round(fraction * 100);
        const thresholdPct = Math.round(contribThreshold * 100);
        if (fractionPct < thresholdPct) continue;
        if (!visibleIdx.has(atomIndex)) continue;

        const atomObj = atoms[atomIndex];
        if (!atomObj) continue;

        viewer.addSphere({
          center: { x: atomObj.x, y: atomObj.y, z: atomObj.z },
          radius: 0.34 + fraction * 0.5,
          color: CONTRIB_COLOR,
          opacity: 0.4 + fraction * 0.35
        });
      }
    }

    // Explicit click-selection halo — always drawn on top, with a thin
    // wireframe outline so it reads clearly even against a similarly
    // sized contribution halo.
    for (const atomIndex of selectedAtoms) {
      if (!visibleIdx.has(atomIndex)) continue;

      const atomObj = atoms[atomIndex];
      if (!atomObj) continue;

      viewer.addSphere({
        center: { x: atomObj.x, y: atomObj.y, z: atomObj.z },
        radius: 0.46,
        color: SELECT_COLOR,
        opacity: 0.5
      });
      viewer.addSphere({
        center: { x: atomObj.x, y: atomObj.y, z: atomObj.z },
        radius: 0.5,
        color: SELECT_COLOR,
        wireframe: true,
        opacity: 0.9
      });
    }

    for (const bond of visibleBonds) {
      const a = atoms[bond.i];
      const b = atoms[bond.j];
      if (!a || !b) continue;

      const mid = {
        x: (a.x + b.x) / 2,
        y: (a.y + b.y) / 2,
        z: (a.z + b.z) / 2
      };

      // Two half-cylinders, each colored by its own atom's element —
      // matches the CPK bicolor convention 3Dmol's native "stick" style
      // already applies during vibration (see startVibration()), so
      // bonds no longer look mono-color/gray only in the static view.
      viewer.addCylinder({
        start: { x: a.x, y: a.y, z: a.z },
        end: mid,
        radius: 0.07,
        color: Elements.getColor(a.element),
        fromCap: 1,
        toCap: 0
      });
      viewer.addCylinder({
        start: { x: b.x, y: b.y, z: b.z },
        end: mid,
        radius: 0.07,
        color: Elements.getColor(b.element),
        fromCap: 1,
        toCap: 0
      });
    }

    // Click handler uses 3Dmol's 0-based model index, mapped back
    // through visibleAtoms (kept as a stable indirection layer even
    // though it's currently just a copy of the full atom list).
    model.setClickable({}, true, (atom) => {
      if (!atom) return;
      const atomObj = visibleAtoms[atom.index];
      if (!atomObj) return;
      if (onAtomClick) onAtomClick(atomObj.index);
    });

    if (!hasZoomed) {
      viewer.zoomTo();
      hasZoomed = true;
    }

    viewer.render();
    renderLegend(elements);
  }

  // Sorted alphabetically, except that H and C are pinned to the front
  // (the common case: organic ligand + a couple of heteroatoms), so the
  // legend order doesn't jump around unpredictably as elements happen
  // to appear in the atom list.
  function renderLegend(elements) {
    const el = document.getElementById("viewer-legend");
    if (!el) return;

    const priority = { H: 0, C: 1 };
    const sorted = [...elements].sort((a, b) => {
      const pa = priority[a] ?? 2;
      const pb = priority[b] ?? 2;
      if (pa !== pb) return pa - pb;
      return a.localeCompare(b);
    });

    el.innerHTML = sorted
      .map(
        (symbol) => `
        <div class="viewer-legend-item">
          <span class="viewer-legend-swatch" style="background:${Elements.getColor(symbol)}"></span>
          <span>${symbol}</span>
        </div>`
      )
      .join("");
  }

  function resetView() {
    if (!viewer) return;
    viewer.zoomTo();
    viewer.render();
  }

  /*
    Animate the currently displayed mode's normal-mode displacement.
    atomContributions: the row.atomContributions array (has atomNumber,
    dx, dy, dz per atom) for the selected mode.

    Implementation note: 3Dmol's model.vibrate() reads dx/dy/dz
    properties directly off the model's own atom objects and builds a
    frame list from them; viewer.animate() then cycles through those
    frames. Our manually-drawn halo spheres and bond cylinders are
    separate GLShapes that would NOT move with the atoms, so they are
    removed for the duration of the animation. Bonds are temporarily
    switched to 3Dmol's native "stick" style instead, which is
    recomputed per frame and therefore does move correctly.
  */
  function startVibration(atomContributions, amplitude = 1.5) {
    if (!viewer || !model || !atomContributions) return;

    viewer.stopAnimate();
    viewer.removeAllShapes(); // drop static halo spheres + bond cylinders

    const byAtomIndex = new Map();
    for (const c of atomContributions) {
      byAtomIndex.set(c.atomNumber - 1, c);
    }

    const modelAtoms = model.selectedAtoms({});
    modelAtoms.forEach((atom, i) => {
      const visAtom = visibleAtoms[i];
      const c = visAtom ? byAtomIndex.get(visAtom.index) : null;
      atom.dx = c ? c.dx : 0;
      atom.dy = c ? c.dy : 0;
      atom.dz = c ? c.dz : 0;
    });

    // Native sphere+stick style so bonds are recomputed per vibration
    // frame, instead of the manual, static addCylinder bonds used for
    // the non-animated view.
    const elements = [...new Set(visibleAtoms.map((a) => a.element))];
    for (const el of elements) {
      model.setStyle(
        { elem: el },
        {
          sphere: { radius: 0.24, color: Elements.getColor(el) },
          stick: { radius: 0.07, color: Elements.getColor(el) }
        }
      );
    }

    model.vibrate(VIBRATE_FRAMES, amplitude, true);
    // "forward"/"backward" are the only two loop modes 3Dmol treats
    // specially; any other string hits its oscillating branch, which
    // bounces the frame index back and forth instead of snapping from
    // the + extreme back to the - extreme every cycle.
    viewer.animate({ loop: "backAndForth", interval: VIBRATE_INTERVAL_MS });
    vibrating = true;
  }

  function stopVibration() {
    if (!viewer) return;
    if (!vibrating) return;

    viewer.stopAnimate();

    if (model && typeof model.setFrame === "function") {
      try { model.setFrame(0); } catch (e) { /* no frames recorded yet */ }
    }

    vibrating = false;
  }

  function isVibrating() {
    return vibrating;
  }

  return {
    init, load, render, resize, resetView, setAtomClickCallback,
    startVibration, stopVibration, isVibrating, setBondTolerance
  };
})();
