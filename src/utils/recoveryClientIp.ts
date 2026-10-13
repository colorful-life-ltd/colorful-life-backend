import { isIP } from "node:net";

/** Canonical keys only from Express's trusted client address, never raw headers. */
export function recoveryClientIp(address: string): string {
  const family = isIP(address);
  if (family === 4) return `v4:${address}`;
  if (family !== 6) return "unknown"; // Conservative shared budget for invalid addresses.
  // Node validates the syntax first. Strip the IPv6 scope ID: it is not host identity.
  let value = address.split("%")[0].toLowerCase();
  if (value.includes(".")) {
    const colon = value.lastIndexOf(":");
    const bytes = value.slice(colon + 1).split(".").map(Number);
    value = value.slice(0, colon + 1) + ((bytes[0] << 8) | bytes[1]).toString(16)
      + ":" + ((bytes[2] << 8) | bytes[3]).toString(16);
  }
  const halves = value.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const words = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;
  const bytes = Buffer.from(words.flatMap(word => {
    const number = parseInt(word, 16);
    return [number >> 8, number & 255];
  }));
  if (bytes.subarray(0, 10).every(byte => byte === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return `v4:${[...bytes.subarray(12)].join(".")}`;
  }
  // /56 groups adjacent /64 client networks, without masking the full allocation.
  return `v6:${bytes.subarray(0, 7).toString("hex")}/56`;
}
