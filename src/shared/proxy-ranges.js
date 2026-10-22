// Tramos de un archivo que necesitan copia ligera: los que usa el proyecto (con margen), unidos si están cerca,
// redondeados a segundos (así se reaprovechan las copias ya hechas) y sin los que ya cubre una copia existente.

export function usedRanges(clips, mediaId, duration, { margin = 2, join = 4 } = {}) {
  const spans = clips
    .filter((c) => c.mediaId === mediaId)
    .map((c) => [Math.max(0, Math.floor(c.in - margin)), Math.min(duration, Math.ceil(c.in + c.duration * (c.speed || 1) + margin))])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1] + join) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  return merged;
}

export function uncoveredRanges(ranges, parts = []) {
  return ranges.filter(([a, b]) => b - a > 0.2 && !parts.some((p) => p.start <= a && p.end >= b));
}

// Partes que siguen sirviendo al añadir la nueva [a, b]: se quitan las que quedan dentro de ella.
export function addPart(parts, part) {
  return [...parts.filter((p) => !(p.start >= part.start && p.end <= part.end)), part].sort((x, y) => x.start - y.start);
}
