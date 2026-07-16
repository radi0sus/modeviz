# ModeViz

`ModeViz` is a browser-based web application for inspecting vibrational
normal modes from ORCA and Gaussian frequency calculations. It shows the
mode table, an interactive 3D structure with per-mode atom-contribution
highlighting and vibration animation, and an IR stick spectrum, side by
side.

The app runs entirely in the browser. Open `index.html`, load an output
file, and explore the modes interactively.

No installation, no Python environment, and no upload to any server are
required — the file is only read locally by the browser.

## Features

- Load ORCA or Gaussian frequency-calculation output files directly in
  the browser (drag & drop or file picker)
- Sortable mode table: mode number, frequency, IR intensity, symmetry,
  main atom(s), and the percentage of a mode's motion involving the
  currently selected atoms
- Adjustable **highlight threshold** controlling which atoms count as
  "main atoms" for a mode, both in the table and in the 3D view
- Interactive 3D viewer (3Dmol.js) with:
  - CPK atom colors and automatically detected bonds
  - a translucent halo highlight for atoms involved in the selected
    mode (color chosen to never collide with any CPK element color)
  - a separate halo highlight for atoms you pick manually, in the
    atom list or by clicking in the 3D view
- **Vibration animation**: play a mode's actual normal-mode
  displacement as a smooth back-and-forth animation, with an
  adjustable amplitude
- Searchable atom list as a precise alternative to clicking small
  spheres in the 3D view
- Toggle atom numbering between 0-based (`C0`, `H1`, …) and 1-based
  (`C1`, `H2`, …) display
- IR stick spectrum (Plotly) — click a stick to select/animate the
  corresponding mode, with the whole stick (not just the marker)
  highlighted for the selected mode
- Light/dark theme via system preference

## Quick start

Download or clone the repository and open:

```text
index.html
```

in a modern web browser.

Then drag and drop an ORCA or Gaussian frequency-calculation output
file into the drop zone, or click it to browse.

## Supported input files

The app auto-detects whether a file is ORCA or Gaussian output.

**ORCA**: requires a `CARTESIAN COORDINATES` block and the normal-mode
frequency/IR section of a `%freq` (or equivalent) calculation.

**Gaussian**: requires a `Standard orientation` (or `Input orientation`,
for jobs run with `nosymm`) block and a frequency job section,
including the `HPModes` (high-precision) output format.

A file without a recognizable atomic geometry block is rejected with
an error message rather than a partial/incorrect load.

## Mode table

Each row is one vibrational mode. Columns:

- **Mode** — mode number
- **ν / cm⁻¹** — frequency
- **Intensity** — IR intensity
- **Sym.** — symmetry label, if present in the output
- **Main atom(s)** — every atom whose contribution to that mode clears
  the highlight threshold (always at least the single strongest atom),
  capped at 5 entries per cell
- **Selected %** — how much of the mode's motion involves the atoms
  currently selected in the 3D view / atom list; shows `–` when
  nothing is selected

Click any column header to sort by it. Click a row (or a stick in the
spectrum) to select that mode.

## Atom selection vs. mode selection

Selecting a mode (table row or spectrum stick) highlights that mode's
main atoms in the 3D view and, if auto-animate is on, plays its
vibration.

Manually picking atoms — in the atom list or by clicking in the 3D
view — is treated as a separate workflow: it clears the current mode
selection first, so the mode's contribution halo and your manual atom
selection are never shown layered on top of each other.

The **Selected %** column in the mode table is independent of which
mode is currently highlighted, so you can select atoms first and then
scan the table to see which modes involve them most.

## Vibration animation

The **Auto-animate** switch controls what happens when a mode is
selected:

- **On** — the mode's normal-mode displacement is animated
  immediately, oscillating smoothly back and forth
- **Off** — selecting a mode only shows the static contribution halo,
  without starting the animation

The **Amplitude** slider scales the displacement and can be adjusted
live while an animation is running.

Technical note: while a mode is animating, bonds are temporarily drawn
using 3Dmol's built-in bond perception (so they move together with the
atoms), instead of the tolerance-based bond list used for the static
view. For typical molecules this looks identical; for unusual
metal–ligand distances the animated view may differ slightly from the
static one.

## 3D viewer

The molecular viewer is powered by 3Dmol.js. Controls include:

- **Reset view** — re-centers and re-zooms the camera
- **Clear selection** — removes all manually selected atoms

Highlight colors are chosen to be distinguishable from every CPK
element color used in the app:

- magenta halo — atom contribution to the selected mode
- cyan halo with outline — atoms selected manually

## Atom indexing

Atoms are labelled as `Element + position in the file`, for example
`C1`, `N2`, `H3`. The **1-based** switch in the atom list controls
whether that position starts counting at `0` (ORCA/Gaussian internal
convention) or `1`. This only changes displayed labels — it does not
change the underlying geometry or mode data.

## 3Dmol.js citation

This application uses [3Dmol.js](https://3dmol.csb.pitt.edu/) for
molecular visualization.

3Dmol.js is licensed under a permissive BSD-3-Clause license (see
`static/vendor/3dmol.LICENSE`).

Please cite:

> Rego, N. and Koes, D. (2015).
> 3Dmol.js: molecular visualization with WebGL.
> *Bioinformatics*, 31(8), 1322–1324.
> https://academic.oup.com/bioinformatics/article/31/8/1322/213186

The IR spectrum is rendered with [Plotly.js](https://plotly.com/javascript/)
(MIT license, see `static/vendor/plotly.LICENSE`).

## License

This project is licensed under the BSD 3-Clause License.

See `LICENSE.txt` for details.

## Known limitations

- Only single-structure frequency-calculation output is supported; files
  containing multiple jobs are parsed for the last matching geometry
  and frequency section.
- Bond detection for the static (non-animated) view is heuristic and
  based on covalent radii; unusual coordination geometries may need
  visual double-checking.
- Vibration animation bonds are recomputed by 3Dmol's own bond
  perception and may not always exactly match the static bond list.
- Analysis state (selection, thresholds, loaded file) is kept only for
  the current browser session.
