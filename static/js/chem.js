"use strict";

/*
  Element color/radius table and bond detection, ported from
  advanced_xyz2tab (Parser.covRadii / Parser.elementColors / Chem.findBonds).
  Kept as a separate global (Elements) to avoid clashing with the
  ORCA/Gaussian parser module.
*/
window.MODEVIEWER_ELEMENTS = (() => {
  const covRadii = {
    H: 0.31, He: 0.28, Li: 1.28, Be: 0.96, B: 0.84, C: 0.76, N: 0.71, O: 0.66,
    F: 0.57, Ne: 0.58, Na: 1.66, Mg: 1.41, Al: 1.21, Si: 1.11, P: 1.07, S: 1.05,
    Cl: 1.02, Ar: 1.06, K: 2.03, Ca: 1.76, Sc: 1.70, Ti: 1.60, V: 1.53, Cr: 1.39,
    Mn: 1.61, Fe: 1.52, Co: 1.50, Ni: 1.24, Cu: 1.32, Zn: 1.22, Ga: 1.22, Ge: 1.20,
    As: 1.19, Se: 1.20, Br: 1.20, Kr: 1.16, Rb: 2.20, Sr: 1.95, Y: 1.90, Zr: 1.75,
    Nb: 1.64, Mo: 1.54, Tc: 1.47, Ru: 1.46, Rh: 1.42, Pd: 1.39, Ag: 1.45, Cd: 1.44,
    In: 1.42, Sn: 1.39, Sb: 1.39, Te: 1.38, I: 1.39, Xe: 1.40, Cs: 2.44, Ba: 2.15,
    La: 2.07, Ce: 2.04, Pr: 2.03, Nd: 2.01, Pm: 1.99, Sm: 1.98, Eu: 1.98, Gd: 1.96,
    Tb: 1.94, Dy: 1.92, Ho: 1.92, Er: 1.89, Tm: 1.90, Yb: 1.87, Lu: 1.87, Hf: 1.75,
    Ta: 1.70, W: 1.62, Re: 1.51, Os: 1.44, Ir: 1.41, Pt: 1.36, Au: 1.36, Hg: 1.32,
    Tl: 1.45, Pb: 1.46, Bi: 1.48, Po: 1.40, At: 1.50, Rn: 1.50
  };

  const elementColors = {
    H: "#ffffff", C: "#404040", N: "#3050f8", O: "#ff0d0d", F: "#90e050",
    Cl: "#1ff01f", Br: "#a62929", I: "#940094", S: "#ffff30", P: "#ff8000",
    Fe: "#e06633", Cu: "#c88033", Zn: "#7d80b0", Co: "#f090a0", Ni: "#50d050",
    Mn: "#9c7ac7", Cr: "#8a99c7", Ti: "#bfc2c7", Ca: "#3dff00", Na: "#ab5cf2",
    Mg: "#8aff00", Al: "#bfa6a6", Si: "#f0c8a0", default: "#ff69b4"
  };

  function getCovRadius(element) {
    return covRadii[element] || 1.5;
  }

  function getColor(element) {
    return elementColors[element] || elementColors.default;
  }

  function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  // tolerancePct e.g. 8 => 8%
  function findBonds(atoms, tolerancePct = 8) {
    const tol = 1 + tolerancePct / 100;
    const bonds = [];

    for (let i = 0; i < atoms.length; i++) {
      for (let j = i + 1; j < atoms.length; j++) {
        const ri = getCovRadius(atoms[i].element);
        const rj = getCovRadius(atoms[j].element);
        const maxDist = (ri + rj) * tol;
        const dist = distance(atoms[i], atoms[j]);

        if (dist <= maxDist) {
          bonds.push({ i: atoms[i].index, j: atoms[j].index, dist });
        }
      }
    }

    return bonds;
  }

  return { getCovRadius, getColor, findBonds, distance };
})();
