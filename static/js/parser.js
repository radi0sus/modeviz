"use strict";

window.MODEVIEWER_PARSER = (() => {
  const NUMBER_PATTERN = "[-+]?(?:\\d+\\.\\d*|\\.\\d+|\\d+)(?:[Ee][-+]?\\d+)?";
  const NUMBER_RE = new RegExp(NUMBER_PATTERN, "g");

  /*
    Atomic number -> element symbol, used to label atoms in the Gaussian
    displacement-vector tables (which only give the atomic number, not
    the symbol). Index 0 is unused so that ELEMENT_SYMBOLS[Z] works
    directly.
  */
  const ELEMENT_SYMBOLS = [
    null,
    "H", "He", "Li", "Be", "B", "C", "N", "O", "F", "Ne",
    "Na", "Mg", "Al", "Si", "P", "S", "Cl", "Ar", "K", "Ca",
    "Sc", "Ti", "V", "Cr", "Mn", "Fe", "Co", "Ni", "Cu", "Zn",
    "Ga", "Ge", "As", "Se", "Br", "Kr", "Rb", "Sr", "Y", "Zr",
    "Nb", "Mo", "Tc", "Ru", "Rh", "Pd", "Ag", "Cd", "In", "Sn",
    "Sb", "Te", "I", "Xe", "Cs", "Ba", "La", "Ce", "Pr", "Nd",
    "Pm", "Sm", "Eu", "Gd", "Tb", "Dy", "Ho", "Er", "Tm", "Yb",
    "Lu", "Hf", "Ta", "W", "Re", "Os", "Ir", "Pt", "Au", "Hg",
    "Tl", "Pb", "Bi", "Po", "At", "Rn", "Fr", "Ra", "Ac", "Th",
    "Pa", "U", "Np", "Pu", "Am", "Cm", "Bk", "Cf", "Es", "Fm",
    "Md", "No", "Lr", "Rf", "Db", "Sg", "Bh", "Hs", "Mt", "Ds",
    "Rg", "Cn", "Nh", "Fl", "Mc", "Lv", "Ts", "Og"
  ];

  function elementSymbolFromAtomicNumber(atomicNumber) {
    return ELEMENT_SYMBOLS[atomicNumber] || `Z${atomicNumber}`;
  }

  function sortContributionsDesc(contribs) {
    return contribs.slice().sort((a, b) => b.fraction - a.fraction);
  }

  function parseOrcaOutput(text, filename = "") {
    /*
      Entry point used by app.js. Auto-detects whether the file is an
      ORCA or a Gaussian output and dispatches to the matching parser.
      Both parsers return the same object shape so the rest of the app
      (spectrum.js, plot.js, export.js, app.js info box) needs no changes.
    */
    const format = detectFileFormat(text);

    if (format === "gaussian") {
      return parseGaussianOutput(text, filename);
    }

    return parseOrcaFormat(text, filename);
  }

  function detectFileFormat(text) {
    /*
      Cheap signature checks, most specific first. Gaussian logs always
      contain the "Entering Gaussian System" banner or a
      "Gaussian NN, Revision X" line near the top; ORCA outputs contain
      the "O   R   C   A" banner or a "Program Version" line.
    */
    if (
      /Entering Gaussian System/i.test(text) ||
      /Gaussian\s+\d+\s*,\s*Revision/i.test(text) ||
      /This is part of the Gaussian/i.test(text)
    ) {
      return "gaussian";
    }

    if (
      /\*\s*O\s+R\s+C\s+A\s*\*/.test(text) ||
      /Program Version/i.test(text) ||
      /IR SPECTRUM/.test(text)
    ) {
      return "orca";
    }

    /*
      Fallback: a Gaussian freq job always prints this exact banner line
      right above the frequency blocks, even if the version banner above
      was stripped from the file for some reason.
    */
    if (/Harmonic frequencies \(cm\*\*-1\)/i.test(text)) {
      return "gaussian";
    }

    /*
      Last-resort fallback for partial/incomplete Gaussian snippets that
      contain neither the version banner nor the section header (e.g. a
      copy-pasted excerpt) - the "Frequencies ---"/"IR Inten(sities) ---"
      line pair is distinctive enough to identify Gaussian's format on
      its own.
    */
    if (
      /^\s*Frequencies\s*-{2,}\s+[-+]?\d/im.test(text) &&
      /^\s*IR\s+Inten(?:sities)?\s*-{2,}\s+[-+]?\d/im.test(text)
    ) {
      return "gaussian";
    }

    return "orca";
  }

  function parseOrcaFormat(text, filename = "") {
    const lines = text.split(/\r?\n/);

    const versionInfo = detectOrcaVersion(text);
    const frequencyScaling = parseFrequencyScalingFactor(lines);
    const vibrational = parseVibrationalFrequencies(lines);
    const ir = parseIRSpectrum(lines, versionInfo.major);

    if (!ir.found) {
      throw new Error("IR SPECTRUM section not found.");
    }

    if (ir.rows.length === 0) {
      throw new Error("IR SPECTRUM section found, but no IR data rows could be parsed.");
    }

    const imaginaryModes = collectImaginaryModes(vibrational.rows, ir.rows);

    /*
      Mode -> Irrep lookup, sourced from the VIBRATIONAL FREQUENCIES
      section (only present when ORCA detected molecular symmetry).
    */
    const symmetryByMode = new Map();
    for (const row of vibrational.rows) {
      if (row.symmetry) {
        symmetryByMode.set(row.mode, row.symmetry);
      }
    }

    /*
      Normal-mode displacement vectors + atom list, used to compute the
      per-atom contribution to each mode (Hauptatome). Both are optional:
      if either section is missing (e.g. a stripped-down file), atom
      contributions are simply omitted for that mode.
    */
    const normalModesIndex = lines.findIndex((l) => l.trim() === "NORMAL MODES");
    const modeVectors = parseOrcaNormalModeVectors(lines);
    const atoms =
      normalModesIndex === -1
        ? []
        : parseOrcaAtomList(lines, normalModesIndex);

    for (const row of ir.rows) {
      row.symmetry = symmetryByMode.get(row.mode) || null;
      row.atomContributions = computeOrcaAtomContributions(
        modeVectors,
        atoms,
        row.mode
      );
    }

    const frequencies = ir.rows.map((row) => row.frequency);
    const intensities = ir.rows.map((row) => row.intensity);
    const modes = ir.rows.map((row) => row.mode);

    const warnings = [];

    if (frequencyScaling.invalid) {
      warnings.push(
        "Invalid ORCA frequency scaling factor detected. Assuming 1.0."
      );
    }

    if (imaginaryModes.length > 0) {
      warnings.push(
        `${imaginaryModes.length} negative frequencies / imaginary modes detected. Spectrum generation continues.`
      );
    }

    const minFrequency = Math.min(...frequencies);
    const maxFrequency = Math.max(...frequencies);
    const maxIntensity = Math.max(...intensities);

    return {
      filename,

      program: "ORCA",
      orcaVersion: versionInfo.version,
      orcaMajorVersion: versionInfo.major,

      frequencyScaling,

      irSectionFound: true,
      irHeader: ir.headerTokens,
      intensityColumnIndex: ir.intensityColumnIndex,
      intensityColumnName: ir.intensityColumnName,

      modes,
      frequencies,
      intensities,
      rows: ir.rows,

      geometry: atoms,
      modeVectors,

      vibrationalFrequenciesFound: vibrational.found,
      vibrationalFrequencies: vibrational.rows,

      imaginaryModes,
      warnings,

      stats: {
        modesParsed: ir.rows.length,
        minFrequency,
        maxFrequency,
        maxIntensity
      }
    };
  }

  function detectOrcaVersion(text) {
    const match = text.match(/Program Version\s+([0-9]+(?:\.[0-9]+)*)/i);

    if (!match) {
      return {
        version: null,
        major: null
      };
    }

    const version = match[1];
    const major = Number.parseInt(version.split(".")[0], 10);

    return {
      version,
      major: Number.isFinite(major) ? major : null
    };
  }

  function parseFrequencyScalingFactor(lines) {
    const scalingRe = new RegExp(
      "Scaling\\s+factor\\s+for\\s+frequencies\\s*=\\s*(" +
        NUMBER_PATTERN +
        ")",
      "i"
    );

    for (const line of lines) {
      const match = line.match(scalingRe);

      if (!match) {
        continue;
      }

      const factor = Number(match[1]);
      const rawLine = line.trim();
      const alreadyApplied = /already\s+applied/i.test(rawLine);

      if (!Number.isFinite(factor) || factor <= 0) {
        return {
          found: false,
          factor: 1.0,
          alreadyApplied: false,
          rawLine,
          invalid: true
        };
      }

      return {
        found: true,
        factor,
        alreadyApplied,
        rawLine,
        invalid: false
      };
    }

    return {
      found: false,
      factor: 1.0,
      alreadyApplied: false,
      rawLine: null,
      invalid: false
    };
  }

  function parseVibrationalFrequencies(lines) {
    const rows = [];

    let inSection = false;
    let dataStarted = false;

    /*
      Trailing group captures the optional Irrep label printed after the
      frequency when the job found molecular symmetry, e.g.:
        6:     401.54 cm**-1    1-E2u(0)
      Jobs without symmetry (point group C1) omit this column entirely.
    */
    const modeFreqRe = new RegExp(
      "^\\s*(\\d+)\\s*:\\s*(" + NUMBER_PATTERN + ")\\s*cm\\*\\*-1\\s*(\\S.*)?$",
      "i"
    );

    for (const line of lines) {
      const trimmed = line.trim();

      if (!inSection) {
        if (trimmed === "VIBRATIONAL FREQUENCIES") {
          inSection = true;
        }
        continue;
      }

      const match = line.match(modeFreqRe);

      if (match) {
        dataStarted = true;

        const irrep = match[3] ? match[3].trim() : null;

        rows.push({
          mode: Number.parseInt(match[1], 10),
          frequency: Number(match[2]),
          symmetry: irrep || null
        });

        continue;
      }

      if (!dataStarted) {
        continue;
      }

      if (trimmed === "") {
        break;
      }

      if (
        trimmed === "IR SPECTRUM" ||
        trimmed === "NORMAL MODES" ||
        trimmed.includes("THERMOCHEMISTRY")
      ) {
        break;
      }
    }

    return {
      found: inSection,
      rows
    };
  }

  function parseIRSpectrum(lines, orcaMajorVersion = null) {
    const rows = [];

    let inSection = false;
    let dataStarted = false;

    let headerTokens = null;
    let freqColumnIndex = null;
    let intensityColumnIndex = null;
    let intensityColumnName = null;

    const dataLineRe = /^\s*(\d+)\s*:\s*(.*)$/;

    for (const line of lines) {
      const trimmed = line.trim();

      if (!inSection) {
        if (trimmed === "IR SPECTRUM") {
          inSection = true;
        }
        continue;
      }

      if (trimmed.startsWith("The first")) {
        break;
      }

      if (isLikelyIRHeaderLine(trimmed)) {
        headerTokens = splitTokens(trimmed);

        freqColumnIndex = findFrequencyColumn(headerTokens);
        intensityColumnIndex = findIntensityColumn(headerTokens);

        if (intensityColumnIndex !== null) {
          intensityColumnName = headerTokens[intensityColumnIndex];
        }

        continue;
      }

      const dataMatch = line.match(dataLineRe);

      if (dataMatch) {
        dataStarted = true;

        const mode = Number.parseInt(dataMatch[1], 10);
        const rest = removeVectorPart(dataMatch[2]);
        const numericTokens = extractNumbers(rest);

        /*
          Data tokens are represented as:
          token 0 = "mode:"
          token 1 = frequency
          token 2 = eps or intensity depending on ORCA/header
          token 3 = Int for ORCA 5/6 with header:
                    Mode freq eps Int T**2 ...
        */
        const dataTokens = [`${mode}:`, ...numericTokens];

        const freqIndex = freqColumnIndex ?? 1;
        const intIndex =
          intensityColumnIndex ??
          fallbackIntensityColumnIndex(orcaMajorVersion);

        const frequency = Number(dataTokens[freqIndex]);
        const intensity = Number(dataTokens[intIndex]);

        if (Number.isFinite(frequency) && Number.isFinite(intensity)) {
          rows.push({
            mode,
            frequency,
            intensity,
            rawTokens: dataTokens,
            rawLine: line
          });
        }

        continue;
      }

      if (!dataStarted) {
        continue;
      }

      if (trimmed === "") {
        break;
      }

      if (
        trimmed.includes("SPECTRUM") ||
        trimmed.includes("NORMAL MODES") ||
        trimmed.includes("THERMOCHEMISTRY")
      ) {
        break;
      }
    }

    const usedFallback = intensityColumnIndex === null;

    return {
      found: inSection,
      rows,
      headerTokens,
      freqColumnIndex,
      intensityColumnIndex:
        intensityColumnIndex ?? fallbackIntensityColumnIndex(orcaMajorVersion),
      intensityColumnName:
        intensityColumnName ??
        (usedFallback && (orcaMajorVersion === 3 || orcaMajorVersion === 4)
          ? "T**2 (a.u.)"
          : "Int (km/mol)")
    };
  }

  function isLikelyIRHeaderLine(line) {
    if (!line) return false;

    const hasMode = /\bMode\b/i.test(line);
    const hasFreq = /\bfreq\b|\bfrequency\b/i.test(line);
    const hasIntensity =
      /\bInt\b/i.test(line) ||
      /\bIntensity\b/i.test(line) ||
      /\bIR\s*Int/i.test(line);

    return hasMode && hasFreq && hasIntensity;
  }

  function splitTokens(line) {
    return line.trim().split(/\s+/);
  }

  function findFrequencyColumn(headerTokens) {
    if (!headerTokens) return null;

    for (let i = 0; i < headerTokens.length; i++) {
      const token = normalizeHeaderToken(headerTokens[i]);

      if (
        token === "freq" ||
        token === "frequency" ||
        token.startsWith("freq")
      ) {
        return i;
      }
    }

    return null;
  }

  function findIntensityColumn(headerTokens) {
    if (!headerTokens) return null;

    for (let i = 0; i < headerTokens.length; i++) {
      const token = normalizeHeaderToken(headerTokens[i]);

      /*
        Preferred ORCA IR intensity column:
        Int in km/mol.

        For your ORCA 5 example:
        Mode freq eps Int T**2 TX TY TZ
                      ^ index 3
      */
      if (
        token === "int" ||
        token === "intensity" ||
        token === "irint" ||
        token === "irintensity"
      ) {
        return i;
      }
    }

    return null;
  }

  function normalizeHeaderToken(token) {
    return String(token)
      .trim()
      .replace(/[^a-zA-Z0-9]/g, "")
      .toLowerCase();
  }

  function fallbackIntensityColumnIndex(orcaMajorVersion) {
    /*
      Fallback only if no usable IR header was found.

      Historical behaviour from the Python script:
      ORCA 5/6: intensity at token index 3
      ORCA 3/4: intensity at token index 2

      Data token index includes mode as token 0:
      6:  15.19  0.000033  0.17 ...
      0   1      2         3
    */

    if (orcaMajorVersion === 3 || orcaMajorVersion === 4) {
      return 2;
    }

    return 3;
  }

  function removeVectorPart(line) {
    /*
      Removes the transition dipole vector part:
      (-0.001989 -0.011548 -0.023317)

      We only want the scalar columns before it.
    */
    return line.split("(")[0];
  }

  function extractNumbers(text) {
    const matches = String(text).match(NUMBER_RE);
    return matches ?? [];
  }

  function collectImaginaryModes(vibrationalRows, irRows, irSourceLabel = "IR SPECTRUM") {
    const byMode = new Map();

    for (const row of vibrationalRows) {
      if (row.frequency < 0) {
        byMode.set(row.mode, {
          mode: row.mode,
          frequency: row.frequency,
          source: "VIBRATIONAL FREQUENCIES"
        });
      }
    }

    for (const row of irRows) {
      if (row.frequency < 0 && !byMode.has(row.mode)) {
        byMode.set(row.mode, {
          mode: row.mode,
          frequency: row.frequency,
          source: irSourceLabel
        });
      }
    }

    return Array.from(byMode.values()).sort((a, b) => a.mode - b.mode);
  }

  function parseOrcaNormalModeVectors(lines) {
    /*
      ORCA's NORMAL MODES section prints a 3N x M matrix (M = number of
      modes) in column blocks of a few modes at a time:

                       0          1          2          3   ...
                   1-A2u   1-E1u(0)   1-E1u(1)      1-A2g   ...
            0   0.000000   0.288675  -0.000000   0.308380   ...
            1   0.000000  -0.000000   0.288675  -0.178043   ...
            ...

      Row index = atomIndex*3 + {0,1,2} for {x,y,z}. Column index is the
      mode number, matching the "Mode" numbers used in the IR SPECTRUM
      section directly (both are 0-based and span translations/
      rotations as well as genuine vibrations).

      The optional symmetry-label row (e.g. "1-A2u  1-E1u(0) ...") is
      intentionally skipped here - symmetry is instead sourced from the
      VIBRATIONAL FREQUENCIES section, which is simpler to parse
      reliably and already keyed by mode number.
    */
    const startIdx = lines.findIndex((l) => l.trim() === "NORMAL MODES");

    if (startIdx === -1) {
      return null;
    }

    const headerIntRe = /^\s*\d+(?:\s+\d+)*\s*$/;
    const dataRowRe = /^\s*(\d+)((?:\s+[-+]?\d+\.\d+(?:[Ee][-+]?\d+)?)+)\s*$/;

    const matrix = new Map();
    let currentCols = null;

    for (let i = startIdx + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed === "IR SPECTRUM") {
        break;
      }

      if (trimmed === "") {
        continue;
      }

      if (headerIntRe.test(trimmed)) {
        currentCols = trimmed.split(/\s+/).map((tok) => Number.parseInt(tok, 10));
        continue;
      }

      const dataMatch = trimmed.match(dataRowRe);

      if (dataMatch && currentCols) {
        const rowIndex = Number.parseInt(dataMatch[1], 10);
        const values = extractNumbers(dataMatch[2]).map(Number);

        if (!matrix.has(rowIndex)) {
          matrix.set(rowIndex, new Map());
        }

        const rowMap = matrix.get(rowIndex);

        for (let c = 0; c < currentCols.length && c < values.length; c++) {
          rowMap.set(currentCols[c], values[c]);
        }
      }

      /*
        Anything else (symmetry-label row, stray text) is silently
        skipped - it neither matches the header nor the data pattern.
      */
    }

    return matrix.size > 0 ? matrix : null;
  }

  function parseOrcaAtomList(lines, beforeIndex) {
    /*
      Picks up the atom order (element symbols only, in row order) from
      the last "CARTESIAN COORDINATES (ANGSTROEM)" block appearing
      before the NORMAL MODES section - this is the geometry the
      frequency calculation actually ran on, even if earlier blocks
      exist from a preceding optimization.
    */
    let sectionStart = -1;

    for (let i = 0; i < beforeIndex && i < lines.length; i++) {
      if (lines[i].trim() === "CARTESIAN COORDINATES (ANGSTROEM)") {
        sectionStart = i;
      }
    }

    if (sectionStart === -1) {
      return [];
    }

    const atoms = [];
    const atomLineRe = new RegExp(
      "^([A-Za-z]{1,3})\\s+(" +
        NUMBER_PATTERN +
        ")\\s+(" +
        NUMBER_PATTERN +
        ")\\s+(" +
        NUMBER_PATTERN +
        ")\\s*$"
    );

    let i = sectionStart + 1;

    if (lines[i] && /^-+$/.test(lines[i].trim())) {
      i++;
    }

    for (; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (trimmed === "") {
        break;
      }

      const match = trimmed.match(atomLineRe);

      if (!match) {
        break;
      }

      atoms.push({
        index: atoms.length,
        element: match[1],
        x: Number(match[2]),
        y: Number(match[3]),
        z: Number(match[4])
      });
    }

    return atoms;
  }

  function parseGaussianStandardOrientation(lines, beforeIndex) {
    /*
      Grabs atomic geometry (element + x,y,z) from the last
      "Standard orientation:" block before the frequency section - this
      is the geometry the freq job actually ran on. Falls back to
      "Input orientation:" for jobs run with nosymm, where Gaussian omits
      the standard-orientation block entirely.

      Block layout:
        Center  Atomic  Atomic             Coordinates (Angstroms)
        Number  Number   Type              X           Y           Z
       ---------------------------------------------------------------
            1      8      0            0.000000    0.000000    0.119159
      */
    let sectionStart = -1;
    const limit = beforeIndex === -1 ? lines.length : beforeIndex;

    for (let i = 0; i < limit; i++) {
      const trimmed = lines[i].trim();
      if (trimmed === "Standard orientation:" || trimmed === "Input orientation:") {
        sectionStart = i;
      }
    }

    if (sectionStart === -1) {
      return [];
    }

    const rowRe = new RegExp(
      "^\\s*(\\d+)\\s+(\\d+)\\s+(-?\\d+)\\s+(" +
        NUMBER_PATTERN + ")\\s+(" + NUMBER_PATTERN + ")\\s+(" + NUMBER_PATTERN + ")\\s*$"
    );

    const atoms = [];
    let dashCount = 0;

    for (let i = sectionStart + 1; i < lines.length; i++) {
      const trimmed = lines[i].trim();

      if (/^-+$/.test(trimmed)) {
        dashCount++;
        if (dashCount === 3) break;
        continue;
      }

      const match = trimmed.match(rowRe);
      if (!match) continue;

      atoms.push({
        index: atoms.length,
        element: elementSymbolFromAtomicNumber(Number(match[2])),
        x: Number(match[4]),
        y: Number(match[5]),
        z: Number(match[6])
      });
    }

    return atoms;
  }

  function computeOrcaAtomContributions(modeMatrix, atoms, modeColumnIndex) {
    if (!modeMatrix || atoms.length === 0) {
      return null;
    }

    const contribs = atoms.map((atom) => {
      let sq = 0;
      const vec = [0, 0, 0];

      for (let comp = 0; comp < 3; comp++) {
        const rowMap = modeMatrix.get(atom.index * 3 + comp);
        const value = rowMap ? rowMap.get(modeColumnIndex) : undefined;
        const v = Number.isFinite(value) ? value : 0;
        vec[comp] = v;
        sq += v * v;
      }

      return { atomNumber: atom.index + 1, element: atom.element, sq, vec };
    });

    const total = contribs.reduce((sum, c) => sum + c.sq, 0);

    if (!(total > 0)) {
      return null;
    }

    return sortContributionsDesc(
      contribs.map((c) => ({
        atomNumber: c.atomNumber,
        element: c.element,
        fraction: c.sq / total,
        // Raw (non-mass-weighted-normalized) displacement direction,
        // kept for vibration animation - not used for the fraction/
        // "main atom" table math above.
        dx: c.vec[0],
        dy: c.vec[1],
        dz: c.vec[2]
      }))
    );
  }

  function parseGaussianOutput(text, filename = "") {
    const lines = text.split(/\r?\n/);

    const versionInfo = detectGaussianVersion(text);
    const ir = parseGaussianFrequencies(lines);

    if (!ir.found) {
      throw new Error(
        "No 'Harmonic frequencies' section found. Is this a Gaussian frequency (Freq) job output?"
      );
    }

    if (ir.rows.length === 0) {
      throw new Error(
        "'Harmonic frequencies' section found, but no 'IR Inten' data could be parsed. Was the job run with IR intensities (plain Freq, not e.g. Freq=ReadFC without IR)?"
      );
    }

    const imaginaryModes = collectImaginaryModes([], ir.rows, "Harmonic frequencies");

    const freqSectionIndex = lines.findIndex((l) =>
      /Harmonic frequencies \(cm\*\*-1\)/i.test(l)
    );
    const geometry = parseGaussianStandardOrientation(lines, freqSectionIndex);

    const frequencies = ir.rows.map((row) => row.frequency);
    const intensities = ir.rows.map((row) => row.intensity);
    const modes = ir.rows.map((row) => row.mode);

    const warnings = [];

    if (imaginaryModes.length > 0) {
      warnings.push(
        `${imaginaryModes.length} negative frequencies / imaginary modes detected. Spectrum generation continues.`
      );
    }

    const minFrequency = Math.min(...frequencies);
    const maxFrequency = Math.max(...frequencies);
    const maxIntensity = Math.max(...intensities);

    return {
      filename,

      program: "Gaussian",

      /*
        Kept as orcaVersion/orcaMajorVersion (rather than introducing new
        field names) so app.js's existing info-box code works unchanged
        for both program types.
      */
      orcaVersion: versionInfo.version,
      orcaMajorVersion: versionInfo.major,

      /*
        Gaussian output files don't carry a separate "apply this scaling
        factor" directive the way ORCA can. Scaling in this app is always
        an app-side, user-controlled setting for Gaussian files.
      */
      frequencyScaling: {
        found: false,
        factor: 1.0,
        alreadyApplied: false,
        rawLine: null,
        invalid: false
      },

      irSectionFound: true,
      irHeader: ["Frequencies", "Red.", "masses", "Frc", "consts", "IR", "Inten"],
      intensityColumnIndex: null,
      intensityColumnName: "IR Inten (km/mol)",

      modes,
      frequencies,
      intensities,
      rows: ir.rows,

      geometry,

      vibrationalFrequenciesFound: false,
      vibrationalFrequencies: [],

      imaginaryModes,
      warnings,

      stats: {
        modesParsed: ir.rows.length,
        minFrequency,
        maxFrequency,
        maxIntensity
      }
    };
  }

  function detectGaussianVersion(text) {
    const match = text.match(/Gaussian\s+(\d+)\s*,\s*Revision\s+([A-Za-z0-9.+-]+)/i);

    if (!match) {
      return {
        version: null,
        major: null
      };
    }

    const major = Number.parseInt(match[1], 10);

    return {
      version: `${match[1]}, Revision ${match[2]}`,
      major: Number.isFinite(major) ? major : null
    };
  }

  function parseGaussianFrequencies(lines) {
    /*
      Gaussian frequency block layout (repeats in groups of up to 3, or
      more with HPModes, modes per block). Two label styles exist
      depending on print settings:

      Standard precision:
        Frequencies --     30.3513                38.2869                54.9623
        Red. masses --      4.6426                 3.9481                 4.4136
        Frc consts  --      0.0025                 0.0034                 0.0079
        IR Inten    --      0.5524                 6.5809                 0.9292
         Atom  AN      X      Y      Z        X      Y      Z        X      Y      Z

      HPModes (freq=HPModes), higher precision, full-word labels, three
      dashes, and a differently-worded displacement table header:
        Frequencies ---   487.4740  487.4740 1269.3077 2381.0728
        Reduced masses ---    12.8774   12.8774   15.9949   12.8774
        Force constants ---     1.8029    1.8029   15.1833   43.0153
        IR Intensities ---     9.2871    9.2871    0.0000   88.9346
        Coord Atom Element:

      With freq=HPModes, Gaussian prints the whole "Harmonic frequencies"
      section TWICE back-to-back: first the HPModes (high precision)
      block, then the ordinary standard-precision block for the exact
      same modes. To avoid double-counting every mode (and therefore
      doubling every peak once broadened/summed), parsing stops as soon
      as a second "Harmonic frequencies" header is seen after the first
      block has already produced rows - only the first (more precise,
      when present) block is kept.

      "Low frequencies ---" (translation/rotation residuals, printed once
      near the top of the section, before any per-mode block) is
      intentionally NOT matched, since the regex requires "Frequencies"
      to start right after leading whitespace - "Low" would be in the way.
    */
    const rows = [];

    let found = false;
    let modeCounter = 0;

    const harmonicRe = /^\s*Harmonic frequencies/i;
    const freqLineRe = /^\s*Frequencies\s*-{2,}\s+(.+)$/i;
    const irLineRe = /^\s*IR\s+Inten(?:sities)?\s*-{2,}\s+(.+)$/i;
    const stdAtomHeaderRe = /^\s*Atom\s+AN\s+X\s+Y\s+Z/i;
    const hpAtomHeaderRe = /^\s*Coord\s+Atom\s+Element:/i;

    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (harmonicRe.test(line)) {
        if (rows.length > 0) {
          /*
            Second (duplicate, lower-precision) section from HPModes -
            stop here and keep only the first block's rows.
          */
          break;
        }

        found = true;
        i++;
        continue;
      }

      const freqMatch = line.match(freqLineRe);

      if (!freqMatch) {
        i++;
        continue;
      }

      found = true;
      const frequencies = extractNumbers(freqMatch[1]).map(Number);

      /*
        The symmetry-label row (e.g. "PIU   PIU   SGG") sits directly
        above the "Frequencies --" line, right below the column-index
        row. It's plain alphabetic labels, one per mode in this block -
        distinguished from other lines by having exactly as many
        whitespace-separated tokens as there are frequencies, none of
        them numeric.
      */
      let symmetries = new Array(frequencies.length).fill(null);
      let back = i - 1;
      while (back >= 0 && lines[back].trim() === "") back--;

      if (back >= 0) {
        const backTokens = lines[back].trim().split(/\s+/);
        const looksLikeSymmetry =
          backTokens.length === frequencies.length &&
          backTokens.every((tok) => /^[A-Za-z][A-Za-z0-9'"]*$/.test(tok));

        if (looksLikeSymmetry) {
          symmetries = backTokens;
        }
      }

      /*
        Scan forward through Red. masses / Frc consts / IR Inten and
        then the displacement-vector table, stopping at the next
        "Frequencies --" block or "Harmonic frequencies" repeat.
      */
      let j = i + 1;
      let irValues = null;
      let tableMode = null;
      const atomTableLines = [];

      while (j < lines.length) {
        const l2 = lines[j];

        if (freqLineRe.test(l2) || harmonicRe.test(l2)) {
          break;
        }

        const irMatch = l2.match(irLineRe);

        if (irMatch) {
          irValues = extractNumbers(irMatch[1]).map(Number);
          j++;
          continue;
        }

        if (stdAtomHeaderRe.test(l2)) {
          tableMode = "std";
          j++;
          continue;
        }

        if (hpAtomHeaderRe.test(l2)) {
          tableMode = "hp";
          j++;
          continue;
        }

        if (tableMode) {
          if (l2.trim() === "") {
            break;
          }

          atomTableLines.push(l2);
          j++;
          continue;
        }

        j++;
      }

      if (!irValues) {
        /*
          No "IR Inten" line found for this block (e.g. intensities
          weren't computed) - drop it and keep scanning from here.
        */
        i = j;
        continue;
      }

      const atomsData = parseGaussianAtomTable(atomTableLines, tableMode);
      const count = Math.min(frequencies.length, irValues.length);

      for (let c = 0; c < count; c++) {
        modeCounter += 1;

        rows.push({
          mode: modeCounter,
          frequency: frequencies[c],
          intensity: irValues[c],
          symmetry: symmetries[c] || null,
          atomContributions: computeGaussianAtomContributions(atomsData, c),
          rawLine: line
        });
      }

      i = j;
    }

    return {
      found,
      rows
    };
  }

  function parseGaussianAtomTable(atomTableLines, tableMode) {
    const atomsData = [];

    if (tableMode === "std") {
      /*
        Standard-precision table, up to 3 modes per block:
          Atom  AN      X      Y      Z        X      Y      Z ...
             1   8    -0.33   0.00  -0.00    -0.00  -0.33   0.00 ...
      */
      for (const line of atomTableLines) {
        const tokens = line.trim().split(/\s+/).map(Number);

        if (tokens.length < 5) continue;

        const atomIndex = tokens[0];
        const atomicNumber = tokens[1];
        const rest = tokens.slice(2);

        const vectorsPerCol = [];
        for (let c = 0; c * 3 < rest.length; c++) {
          vectorsPerCol.push([
            rest[c * 3] ?? 0,
            rest[c * 3 + 1] ?? 0,
            rest[c * 3 + 2] ?? 0
          ]);
        }

        atomsData.push({ atomIndex, atomicNumber, vectorsPerCol });
      }

      return atomsData;
    }

    if (tableMode === "hp") {
      /*
        HPModes table, rows come in groups of 3 (coord 1/2/3 = x/y/z)
        per atom, one column per mode in this block:
          Coord Atom Element:
            1     1     8          0.00010  -0.33138  -0.00000 ...
            2     1     8         -0.33138  -0.00010   0.00000 ...
            3     1     8          0.00000  -0.00000   0.70711 ...
      */
      const byAtom = new Map();

      for (const line of atomTableLines) {
        const tokens = line.trim().split(/\s+/).map(Number);

        if (tokens.length < 4) continue;

        const coord = tokens[0];
        const atomIndex = tokens[1];
        const atomicNumber = tokens[2];
        const values = tokens.slice(3);

        if (!byAtom.has(atomIndex)) {
          byAtom.set(atomIndex, {
            atomIndex,
            atomicNumber,
            x: [],
            y: [],
            z: []
          });
        }

        const rec = byAtom.get(atomIndex);

        if (coord === 1) rec.x = values;
        else if (coord === 2) rec.y = values;
        else if (coord === 3) rec.z = values;
      }

      for (const rec of byAtom.values()) {
        const nCols = Math.max(rec.x.length, rec.y.length, rec.z.length);
        const vectorsPerCol = [];

        for (let c = 0; c < nCols; c++) {
          vectorsPerCol.push([
            rec.x[c] ?? 0,
            rec.y[c] ?? 0,
            rec.z[c] ?? 0
          ]);
        }

        atomsData.push({
          atomIndex: rec.atomIndex,
          atomicNumber: rec.atomicNumber,
          vectorsPerCol
        });
      }

      atomsData.sort((a, b) => a.atomIndex - b.atomIndex);
      return atomsData;
    }

    return atomsData;
  }

  function computeGaussianAtomContributions(atomsData, columnIndex) {
    if (!atomsData || atomsData.length === 0) {
      return null;
    }

    const contribs = atomsData.map((atom) => {
      const v = atom.vectorsPerCol[columnIndex] || [0, 0, 0];
      const sq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];

      return {
        atomNumber: atom.atomIndex,
        element: elementSymbolFromAtomicNumber(atom.atomicNumber),
        sq,
        vec: v
      };
    });

    const total = contribs.reduce((sum, c) => sum + c.sq, 0);

    if (!(total > 0)) {
      return null;
    }

    return sortContributionsDesc(
      contribs.map((c) => ({
        atomNumber: c.atomNumber,
        element: c.element,
        fraction: c.sq / total,
        // Raw displacement direction, kept for vibration animation.
        dx: c.vec[0],
        dy: c.vec[1],
        dz: c.vec[2]
      }))
    );
  }

  return {
    parseOrcaOutput,
    parseOrcaFormat,
    parseGaussianOutput,
    parseGaussianStandardOrientation,
    detectFileFormat,
    elementSymbolFromAtomicNumber
  };
})();