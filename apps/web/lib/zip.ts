/**
 * Minimal ZIP writer — STORE only, no compression.
 *
 * Exists so the admin backup can hand over one .zip containing the JSON dump
 * plus every signature as a real PNG, without adding an archive dependency to
 * the web app. Store-only is deliberate: the payloads are PNGs (already
 * deflated) and one JSON file, so compression would buy little and cost a
 * library. The format is the 1989 one — local file header per entry, central
 * directory, end record — nothing modern (no zip64), which caps entries at
 * 4 GB each and 65 535 total; the backup is megabytes, so the cap is theory.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair, the only timestamp classic ZIP knows. */
function dosDateTime(d: Date): { date: number; time: number } {
  return {
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
  };
}

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. "signatures/B1234_customer.png". */
  name: string;
  data: Uint8Array;
}

export function buildZip(entries: ZipEntry[], when: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { date, time } = dosDateTime(when);
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff]);
  const u32 = (v: number) => new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  };

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    // Local file header: signature, version 2.0, flags 0, method 0 (store).
    const local = cat(
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0),
      name, e.data,
    );
    // Matching central-directory record, pointing back at the local header.
    central.push(cat(
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(time), u16(date),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ));
    chunks.push(local);
    offset += local.length;
  }

  const dir = cat(...central);
  const eocd = cat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(dir.length), u32(offset), u16(0),
  );
  return cat(...chunks, dir, eocd);
}
