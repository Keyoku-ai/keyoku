import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface BoundedArtifact {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
}

/** Read bytes only after lexical and realpath containment both pass. */
export function readBoundedArtifact(rootInput: string, pathInput: string): BoundedArtifact {
  const root = resolve(rootInput);
  const absolutePath = resolve(root, pathInput);
  const relativePath = relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact path is outside the verified root: ${pathInput}`);
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`Artifact was not found: ${relativePath}`);
  }
  const canonicalRoot = realpathSync(root);
  const canonicalArtifact = realpathSync(absolutePath);
  const expectedCanonicalPath = resolve(canonicalRoot, relativePath);
  if (canonicalArtifact !== expectedCanonicalPath) {
    throw new Error(`Artifact path traverses a symbolic link: ${relativePath}`);
  }
  const canonicalRelative = relative(canonicalRoot, canonicalArtifact);
  if (!canonicalRelative || canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) {
    throw new Error(`Artifact realpath escapes the verified root: ${relativePath}`);
  }
  return { absolutePath, relativePath, bytes: readFileSync(canonicalArtifact) };
}

export type PortableMediaType = "image/png" | "image/webp" | "image/jpeg" | "video/mp4" | "video/webm";

export function mediaTypeForPath(path: string): PortableMediaType | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".webm")) return "video/webm";
  return undefined;
}

export function mediaSignatureMatches(bytes: Buffer, mediaType: PortableMediaType): boolean {
  if (mediaType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mediaType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === "image/webp") return bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (mediaType === "video/mp4") return bytes.length >= 12 && bytes.subarray(4, 8).toString("ascii") === "ftyp";
  return bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
}
